import express from 'express';
import axios from 'axios';
const app = express();
 
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const API_KEY = process.env.FRESHDESK_API_KEY;
const SURVEY_ID = process.env.SURVEY_ID;
const CUSTOM_OBJECT_SCHEMA_ID = process.env.CUSTOM_OBJECT_SCHEMA_ID;

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;
const EVENT_LOG_LIMIT = 200;
const eventLog = [];

function logEvent(event, details = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        ...details
    };
    eventLog.push(entry);
    if (eventLog.length > EVENT_LOG_LIMIT) {
        eventLog.shift();
    }
    console.log(JSON.stringify(entry));
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

axios.interceptors.response.use(null, async error => {
    const requestConfig = error.config;
    if (error.response?.status !== 429 || !requestConfig) {
        throw error;
    }

    const retryCount = requestConfig.rateLimitRetryCount || 0;
    if (retryCount >= MAX_RATE_LIMIT_RETRIES) {
        throw error;
    }

    requestConfig.rateLimitRetryCount = retryCount + 1;
    const retryAfterHeader = error.response.headers?.['retry-after'];
    const retryAfterSeconds = Number(retryAfterHeader);
    const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : DEFAULT_RATE_LIMIT_DELAY_MS * (2 ** retryCount);

    console.warn(`Freshdesk rate limit reached; retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RATE_LIMIT_RETRIES}).`);
    await wait(delay);
    return axios(requestConfig);
});
 
// Maps the numeric rating in the URL (?r=1..5) to the Freshdesk dropdown value
const RATING_MAP = {
    '1': '1 Star',
    '2': '2 Stars',
    '3': '3 Stars',
    '4': '4 Stars',
    '5': '5 Stars'
};
 
// ── Deduplication: suppress duplicate requests for the same ticket within this window ──
const DEDUP_WINDOW_MS = 10_000; // 10 seconds
const dedupLocks = new Map();  // ticketId:interactionId:rating → timestamp
const activeRatingRequests = new Set();
 
// Returns null if not a duplicate (and registers the lock).
// Returns the stored ratingLabel if this is a duplicate within the window.
function checkDuplicate(ticketId, interactionId, ratingLabel) {
    const now = Date.now();
    const dedupKey = `${ticketId}:${interactionId}:${ratingLabel}`;
    if (dedupLocks.has(dedupKey)) {
        const timestamp = dedupLocks.get(dedupKey);
        if (now - timestamp < DEDUP_WINDOW_MS) {
            return ratingLabel; // duplicate — return what was originally submitted
        }
    }
    dedupLocks.set(dedupKey, now);
    setTimeout(() => dedupLocks.delete(dedupKey), DEDUP_WINDOW_MS + 500);
    return null;
}
 
// Known email-scanner / link-prefetch User-Agent substrings to ignore
const BOT_UA_PATTERNS = [
    'safebrowsing', 'linkscanner', 'proofpoint', 'mimecast',
    'barracuda', 'symantec', 'sophos', 'ironport', 'qualys',
    'preview', 'crawler', 'spider', 'bot'
];
 
function isBotRequest(req) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    return BOT_UA_PATTERNS.some(p => ua.includes(p));
}

app.get('/', (req, res) => {
    res.status(200).send('MoEngage rating webhook is running.');
});

app.get('/events', (req, res) => {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, EVENT_LOG_LIMIT)
        : EVENT_LOG_LIMIT;
    res.status(200).json(eventLog.slice(-limit));
});

async function getAgentInteraction(ticketId, requestedInteractionId) {
    const conversationsResponse = await axios.get(
        `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}/conversations?per_page=100`,
        {
            auth: { username: API_KEY, password: 'X' },
            headers: { 'Content-Type': 'application/json' }
        }
    );
    const conversations = Array.isArray(conversationsResponse.data)
        ? conversationsResponse.data
        : conversationsResponse.data?.conversations || [];
    const agentInteractions = conversations
        .filter(conversation => conversation.private === false && conversation.incoming !== true)
        .sort((first, second) => new Date(first.created_at) - new Date(second.created_at));
    const requestedId = requestedInteractionId === undefined || requestedInteractionId === ''
        ? null
        : Number(requestedInteractionId);
    if (requestedId !== null && !Number.isInteger(requestedId)) {
        throw new Error(`Invalid interaction id for ticket ${ticketId}`);
    }

    const exactInteraction = requestedId === null
        ? null
        : conversations.find(interaction => String(interaction.id) === String(requestedInteractionId));
    const selectedInteractionIndex = requestedId === null
        ? agentInteractions.length - 1
        : agentInteractions.findIndex(interaction => String(interaction.id) === String(requestedInteractionId));
    const selectedInteraction = exactInteraction || agentInteractions[selectedInteractionIndex];

    const interactionId = Number(selectedInteraction?.id ?? requestedId);
    if (!Number.isInteger(interactionId)) {
        throw new Error(requestedId === null
            ? `No agent reply found for ticket ${ticketId}`
            : `Interaction ${requestedId} was not found for ticket ${ticketId}`);
    }

    return {
        interactionId,
        interactionNumber: selectedInteractionIndex >= 0 ? selectedInteractionIndex + 1 : agentInteractions.length + 1
    };
}

async function getCustomObjectRecords() {
    const recordsUrl = `https://${FRESHDESK_DOMAIN}/api/v2/custom_objects/schemas/${CUSTOM_OBJECT_SCHEMA_ID}/records`;
    const requestConfig = {
        auth: { username: API_KEY, password: 'X' },
        headers: { 'Content-Type': 'application/json' }
    };

    const recordsResponse = await axios.get(recordsUrl, requestConfig);
    const responseData = recordsResponse.data;
    return Array.isArray(responseData)
        ? responseData
        : responseData?.records || responseData?.data || [];
}

async function findExistingCustomObjectRecord(payload) {
    const records = await getCustomObjectRecords();
    return records.find(record => {
        const recordData = record.data || record;
        return String(recordData.ticket_id) === String(payload.data.ticket_id)
            && String(recordData.interaction_id) === String(payload.data.interaction_id);
    }) || null;
}

async function saveCustomObjectRecord(payload, existingRecord = null) {
    const recordsUrl = `https://${FRESHDESK_DOMAIN}/api/v2/custom_objects/schemas/${CUSTOM_OBJECT_SCHEMA_ID}/records`;
    const requestConfig = {
        auth: { username: API_KEY, password: 'X' },
        headers: { 'Content-Type': 'application/json' }
    };

    const recordToUpdate = existingRecord || await findExistingCustomObjectRecord(payload);
    const existingRecordId = recordToUpdate?.display_id || recordToUpdate?.id;
    if (existingRecordId) {
        const updateResponse = await axios.put(
            `${recordsUrl}/${existingRecordId}`,
            { ...payload, version: recordToUpdate.version },
            requestConfig
        );
        return updateResponse.data;
    }

    try {
        const createResponse = await axios.post(recordsUrl, payload, requestConfig);
        return createResponse.data;
    } catch (err) {
        const isDuplicateName = err.response?.data?.errors?.some(error =>
            error.name === 'name' && error.message?.includes('Another record is associated')
        );

        if (!isDuplicateName) {
            throw err;
        }

        const existingRecord = await findExistingCustomObjectRecord(payload);

        const existingRecordId = existingRecord?.display_id || existingRecord?.id;
        if (!existingRecordId) {
            throw err;
        }

        const updateResponse = await axios.put(
            `${recordsUrl}/${existingRecordId}`,
            { ...payload, version: existingRecord.version },
            requestConfig
        );
        return updateResponse.data;
    }
}
 
// Helper: build a self-closing HTML page with a message
function buildAutoClosePage(message, isAlreadyRated = false, rating = 0) {
    const color = isAlreadyRated ? '#e67e22' : '#27ae60';
    const icon  = isAlreadyRated ? '⚠️' : '✓';
    const stars = Array.from({ length: 5 }, (_, index) =>
        `<span style="font-size:36px; color:#808080;">${index < rating ? '★' : '☆'}</span>`
    ).join('');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Rating</title>
    <!--
      Meta refresh is a browser-native redirect — it requires NO JavaScript
      and cannot be blocked by any browser security policy.
            The rating remains visible after submission.
    -->
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        background: #f9f9f9;
        font-family: sans-serif;
      }
      .card {
        background: #fff;
        border-radius: 12px;
        padding: 36px 48px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.10);
        text-align: center;
        max-width: 420px;
        width: 90%;
      }
      .icon { font-size: 48px; margin-bottom: 16px; }
            .stars { margin-bottom: 16px; }
      .msg  { color: ${color}; font-size: 18px; font-weight: 600; margin-bottom: 10px; }
      .sub  { color: #999; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">${icon}</div>
        <div class="stars">${stars}</div>
      <div class="msg">${message}</div>
            <div class="sub">Your feedback has been recorded.</div>
    </div>
        <script>
            setTimeout(() => {
                window.open('', '_self');
                window.close();
            }, 1500);
        </script>
  </body>
</html>`;
}
 
app.get('/rate', async (req, res) => {
    const ticketId = req.query.t;
    const rating   = req.query.r;
    const requestedInteractionId = req.query.i ?? req.query.interaction_id ?? req.query.interactionId;
 
    // Convert numeric param to dropdown label (e.g. "3" → "3 Stars")
    const ratingLabel = RATING_MAP[String(rating)];
 
    if (!ticketId || !ratingLabel) {
        return res.status(400).send('Missing or invalid ticket id / rating. Rating must be 1–5.');
    }

    const requestId = `${ticketId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let processingStage = 'request-received';
    logEvent('rating-requested', { requestId, ticketId: String(ticketId), rating: Number(rating) });
 
    // ── Guard 1: Silently drop known email-scanner bots (they don't render HTML) ──
    if (isBotRequest(req)) {
        logEvent('rating-request-ignored', {
            ticketId: String(ticketId),
            reason: 'bot-or-scanner',
            userAgent: req.headers['user-agent'] || ''
        });
        return res.status(200).send('OK');
    }
 
    let interactionId;
    let interactionNumber;
    let ratingRequestKey;
    try {
        // Fetch the ticket with requester details to get the contact email
        processingStage = 'fetch-ticket';
        const ticketRes = await axios.get(
            `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}?include=requester`,
            {
                auth: { username: API_KEY, password: 'X' },
                headers: { 'Content-Type': 'application/json' }
            }
        );
       
        const contactEmail = ticketRes.data?.requester?.email || "unknown";
        processingStage = 'resolve-interaction';
        ({ interactionId, interactionNumber } = await getAgentInteraction(ticketId, requestedInteractionId));
        ratingRequestKey = `${ticketId}:${interactionId}:${rating}`;
        const duplicateLabel = checkDuplicate(ticketId, interactionId, ratingLabel);

        if (duplicateLabel !== null) {
            logEvent('rating-request-duplicate', { ticketId: String(ticketId), interactionId, rating: Number(rating) });
            return res.status(200).send(buildAutoClosePage(`Rated ${duplicateLabel} — Thank you!`, false, Number(rating)));
        }

        if (activeRatingRequests.has(ratingRequestKey)) {
            logEvent('rating-request-duplicate-in-flight', { ticketId: String(ticketId), interactionId, rating: Number(rating) });
            return res.status(200).send(buildAutoClosePage(`Rated ${ratingLabel} — Thank you!`, false, Number(rating)));
        }
        activeRatingRequests.add(ratingRequestKey);

        processingStage = 'check-existing-record';
        const existingRatingRecord = await findExistingCustomObjectRecord({
            data: {
                ticket_id: String(ticketId),
                interaction_id: interactionId,
                final_rating: Number(rating)
            }
        });
        if (existingRatingRecord) {
            activeRatingRequests.delete(ratingRequestKey);
            logEvent('rating-request-already-recorded', { ticketId: String(ticketId), interactionId, rating: Number(rating) });
            return res.status(200).send(buildAutoClosePage(`Rated ${ratingLabel} — Thank you!`, false, Number(rating)));
        }
 
        // Submit CSAT response as required by Freshdesk
        processingStage = 'save-csat-response';
        const payload = {
            ticket_id: Number(ticketId),
            answers: [
                {
                    question_id: "Q_1",
                    value: Number(rating)
                }
            ]
        };
 
        try {
            await axios.post(
                `https://${FRESHDESK_DOMAIN}/api/v2/customer-satisfaction/surveys/${SURVEY_ID}/responses`,
                payload,
                {
                    auth: { username: API_KEY, password: 'X' },
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            logEvent('csat-response-saved', { ticketId: String(ticketId), rating: Number(rating) });
        } catch (err) {
            logEvent('csat-response-failed', {
                ticketId: String(ticketId),
                rating: Number(rating),
                error: err.response?.data || err.message || String(err)
            });
        }

        processingStage = 'update-ticket-rating';
        try {
            await axios.put(
                `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}`,
                {
                    custom_fields: {
                        cf_csat_rating: String(rating)
                    }
                },
                {
                    auth: { username: API_KEY, password: 'X' },
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        } catch (err) {
            logEvent('ticket-rating-update-failed', {
                ticketId: String(ticketId),
                rating: Number(rating),
                error: err.response?.data || err.message || String(err)
            });
        }
 
        logEvent('interaction-resolved', { ticketId: String(ticketId), interactionId, interactionNumber });
        const customObjectPayload = {
            data: {
            name: `${rating}Email${interactionId}`,
                interaction_id: interactionId,
                interaction_number: interactionNumber,
                ticket_id: String(ticketId),
                source: 'Email'
            }
        };
        processingStage = 'build-custom-object-record';
        const ticketRecordsBeforeSave = (await getCustomObjectRecords()).filter(record => {
            const recordData = record.data || record;
            return String(recordData.ticket_id) === String(ticketId)
                && String(recordData.interaction_id) !== String(interactionId);
        });
        const ratingsGiven = ticketRecordsBeforeSave
            .sort((first, second) => Number((first.data || first).interaction_number) - Number((second.data || second).interaction_number))
            .map(record => Number((record.data || record).final_rating))
            .filter(Number.isFinite)
            .reverse()
            .reduce((ratings, previousRating) => ratings.concat(previousRating), [Number(rating)])
            .join(', ');
        const recordPayload = {
            ...customObjectPayload,
            data: {
                ...customObjectPayload.data,
                ratings_given: ratingsGiven,
                final_rating: Number(rating)
            }
        };
        const existingRecord = await findExistingCustomObjectRecord(recordPayload);

        processingStage = 'save-custom-object-record';
        const savedRecord = await saveCustomObjectRecord(recordPayload, existingRecord);
        logEvent(existingRecord ? 'custom-object-record-updated' : 'custom-object-record-created', {
            ticketId: String(ticketId),
            interactionId,
            interactionNumber,
            rating: Number(rating),
            recordId: savedRecord?.display_id || savedRecord?.id || null
        });

        const ticketRecords = (await getCustomObjectRecords()).filter(record => {
            const recordData = record.data || record;
            return String(recordData.ticket_id) === String(ticketId);
        });
        const interactionRatings = ticketRecords
            .map(record => Number((record.data || record).final_rating))
            .filter(Number.isFinite);
        const overallTicketAverage = interactionRatings.length
            ? Math.round(interactionRatings.reduce((total, value) => total + value, 0) / interactionRatings.length)
            : null;

        processingStage = 'update-ticket-average';
        await axios.put(
            `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}`,
            {
                custom_fields: {
                    cf_average_ticket_rating: overallTicketAverage
                }
            },
            {
                auth: { username: API_KEY, password: 'X' },
                headers: { 'Content-Type': 'application/json' }
            }
        );
 
        logEvent('rating-processing-complete', {
            ticketId: String(ticketId),
            rating: Number(rating),
            overallTicketAverage,
            recordUpdatedTime: savedRecord?.updated_time || null
        });
        activeRatingRequests.delete(ratingRequestKey);
 
        return res
            .status(200)
            .send(buildAutoClosePage(`Rated ${ratingLabel} — Thank you!`, false, Number(rating)));
 
    } catch (err) {
        // Allow the user to retry after a failed Freshdesk request.
        if (interactionId) {
            dedupLocks.delete(`${ticketId}:${interactionId}:${ratingLabel}`);
        }
        logEvent('rating-processing-failed', {
            requestId,
            ticketId: String(ticketId),
            interactionId: interactionId || null,
            stage: processingStage,
            rating: Number(rating),
            error: err.response?.data || err.message || String(err)
        });
        for (const requestKey of activeRatingRequests) {
            if (requestKey.startsWith(`${ticketId}:`)) {
                activeRatingRequests.delete(requestKey);
            }
        }
        return res.status(500).send('Something went wrong, please try again.');
    }
});
 
// Blank landing page — tab is redirected here after rating so it appears empty
app.get('/done', (req, res) => {
    res.send('<!DOCTYPE html><html><head><title> </title><style>html,body{margin:0;padding:0;background:#f9f9f9;}</style></head><body></body></html>');
});
 
const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Listening on port ${port}`));