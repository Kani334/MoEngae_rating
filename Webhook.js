import express from 'express';
import axios from 'axios';
const app = express();
 
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const API_KEY = process.env.FRESHDESK_API_KEY;
const SURVEY_ID = process.env.SURVEY_ID;
const CUSTOM_OBJECT_SCHEMA_ID = process.env.CUSTOM_OBJECT_SCHEMA_ID;

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;

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
const dedupLocks = new Map();  // ticketId → { ts, ratingLabel }
 
// Returns null if not a duplicate (and registers the lock).
// Returns the stored ratingLabel if this is a duplicate within the window.
function checkDuplicate(ticketId, ratingLabel) {
    const now = Date.now();
    if (dedupLocks.has(ticketId)) {
        const entry = dedupLocks.get(ticketId);
        if (now - entry.ts < DEDUP_WINDOW_MS && entry.ratingLabel === ratingLabel) {
            return entry.ratingLabel; // duplicate — return what was originally submitted
        }
    }
    // Not a duplicate — register this request
    dedupLocks.set(ticketId, { ts: now, ratingLabel });
    setTimeout(() => dedupLocks.delete(ticketId), DEDUP_WINDOW_MS + 500);
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

async function getLatestAgentInteraction(ticketId) {
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
    const agentReplies = conversations
        .filter(conversation => conversation.private === false && conversation.incoming !== true)
        .sort((first, second) => new Date(first.created_at) - new Date(second.created_at));
    const latestAgentReply = agentReplies[agentReplies.length - 1];

    const interactionId = Number(latestAgentReply?.id);
    if (!Number.isInteger(interactionId)) {
        throw new Error(`No agent reply found for ticket ${ticketId}`);
    }

    return {
        interactionId,
        interactionNumber: agentReplies.length
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
 
    // Convert numeric param to dropdown label (e.g. "3" → "3 Stars")
    const ratingLabel = RATING_MAP[String(rating)];
 
    if (!ticketId || !ratingLabel) {
        return res.status(400).send('Missing or invalid ticket id / rating. Rating must be 1–5.');
    }
 
    // ── Guard 1: Silently drop known email-scanner bots (they don't render HTML) ──
    if (isBotRequest(req)) {
        console.log(`[${new Date().toISOString()}] Ignored bot/scanner request for ticket ${ticketId} (UA: ${req.headers['user-agent']})`);
        return res.status(200).send('OK');
    }
 
    // ── Guard 2: Deduplicate — if same ticket seen within 10 s, show thank-you page ──
    // The scanner fires first, so the REAL user click is usually the duplicate.
    // We must return proper HTML (with meta-refresh) so the user's tab redirects.
    const duplicateLabel = checkDuplicate(ticketId, ratingLabel);
    if (duplicateLabel !== null) {
        console.log(`[${new Date().toISOString()}] Duplicate request for ticket ${ticketId} suppressed — showing thank-you page.`);
        return res.status(200).send(buildAutoClosePage(`Rated ${duplicateLabel} — Thank you!`, false, Number(rating)));
    }
 
    try {
        // Fetch the ticket with requester details to get the contact email
        const ticketRes = await axios.get(
            `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}?include=requester`,
            {
                auth: { username: API_KEY, password: 'X' },
                headers: { 'Content-Type': 'application/json' }
            }
        );
       
        const contactEmail = ticketRes.data?.requester?.email || "unknown";
 
        // Submit CSAT response as required by Freshdesk
        const payload = {
            ticket_id: Number(ticketId),
            answers: [
                {
                    question_id: "Q_1",
                    value: Number(rating)
                }
            ]
        };
 
        await axios.post(
            `https://${FRESHDESK_DOMAIN}/api/v2/customer-satisfaction/surveys/${SURVEY_ID}/responses`,
            payload,
            {
                auth: { username: API_KEY, password: 'X' },
                headers: { 'Content-Type': 'application/json' }
            }
        );

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
 
        // Use the latest private note as the agent interaction identity.
        const { interactionId, interactionNumber } = await getLatestAgentInteraction(ticketId);
        const customObjectPayload = {
            data: {
                name: `Rating-${ticketId}-${interactionId}`,
                interaction_id: interactionId,
                interaction_number: interactionNumber,
                ticket_id: String(ticketId),
                source: 'Email'
            }
        };
 
        const existingRecord = await findExistingCustomObjectRecord(customObjectPayload);
        const ticketRecordsBeforeSave = (await getCustomObjectRecords()).filter(record => {
            const recordData = record.data || record;
            return String(recordData.ticket_id) === String(ticketId)
                && String(recordData.interaction_id) !== String(interactionId);
        });
        const ratingsGiven = ticketRecordsBeforeSave
            .sort((first, second) => Number((first.data || first).interaction_number) - Number((second.data || second).interaction_number))
            .map(record => Number((record.data || record).final_rating))
            .filter(Number.isFinite)
            .concat(Number(rating))
            .join(', ');

        const savedRecord = await saveCustomObjectRecord({
            ...customObjectPayload,
            data: {
                ...customObjectPayload.data,
                ratings_given: ratingsGiven,
                final_rating: Number(rating)
            }
        }, existingRecord);

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
 
        console.log(`[${new Date().toISOString()}] Ticket ${ticketId} updated with CSAT and custom object rating "${ratingLabel}" (record updated_time: ${savedRecord?.updated_time || 'created now'})`);
 
        return res
            .status(200)
            .send(buildAutoClosePage(`Rated ${ratingLabel} — Thank you!`, false, Number(rating)));
 
    } catch (err) {
        // Allow the user to retry after a failed Freshdesk request.
        dedupLocks.delete(ticketId);
        console.error(`[${new Date().toISOString()}] Failed to process ticket ${ticketId}:`, err.response?.data || err.message);
        return res.status(500).send('Something went wrong, please try again.');
    }
});
 
// Blank landing page — tab is redirected here after rating so it appears empty
app.get('/done', (req, res) => {
    res.send('<!DOCTYPE html><html><head><title> </title><style>html,body{margin:0;padding:0;background:#f9f9f9;}</style></head><body></body></html>');
});
 
const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Listening on port ${port}`));