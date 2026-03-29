const { Client } = require('discord.js-selfbot-v13');

const client = new Client({
    checkUpdate: false,
    ws: { properties: { $browser: "Discord iOS" } }
});

const CATEGORY_ID = process.env.CATEGORY_ID;
const USER_TOKEN = process.env.USER_TOKEN;

client.on('ready', () => {
    console.log(`[READY] ${client.user.tag} (${client.user.id})`);
    console.log(`[CONFIG] Category: ${CATEGORY_ID}`);
    console.log(`[CONFIG] Session ID: ${client.sessionId?.slice(0, 10)}...`);
});

client.on('channelCreate', async (channel) => {
    console.log(`\n[CHANNEL CREATE] ${channel.name} | Parent: ${channel.parentId}`);
    
    if (channel.parentId !== CATEGORY_ID) {
        console.log(`[SKIP] Wrong category (expected ${CATEGORY_ID})`);
        return;
    }
    
    console.log(`[MATCH] Correct category, waiting for messages...`);
    
    // Multiple attempts with backoff
    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`[ATTEMPT ${attempt}] Fetching messages...`);
        
        try {
            const messages = await channel.messages.fetch({ limit: 10 });
            console.log(`[FETCHED] ${messages.size} messages`);
            
            let found = false;
            for (const [id, msg] of messages) {
                console.log(`[MSG ${id}] Author: ${msg.author?.tag || 'Unknown'} | Components: ${msg.components?.length || 0}`);
                
                if (processMessage(msg)) {
                    found = true;
                }
            }
            
            if (found) return;
            
            console.log(`[RETRY] No claim buttons found, waiting...`);
            await new Promise(r => setTimeout(r, 300 * attempt));
            
        } catch (e) {
            console.error(`[FETCH ERROR] ${e.message}`);
        }
    }
    
    console.log(`[GIVE UP] No claim buttons found after 3 attempts`);
});

client.on('messageCreate', async (message) => {
    if (message.channel.parentId !== CATEGORY_ID) return;
    
    console.log(`\n[MESSAGE CREATE] ${message.id} in ${message.channel.name}`);
    console.log(`[AUTHOR] ${message.author?.tag || message.author?.id || 'Unknown'}`);
    console.log(`[EMBEDS] ${message.embeds?.length || 0} | [COMPONENTS] ${message.components?.length || 0}`);
    
    processMessage(message);
});

function processMessage(message) {
    if (!message.components || message.components.length === 0) {
        console.log(`[SKIP] No components`);
        return false;
    }
    
    let claimed = false;
    
    for (let r = 0; r < message.components.length; r++) {
        const row = message.components[r];
        console.log(`[ROW ${r}] ${row.components?.length} components`);
        
        for (let c = 0; c < row.components.length; c++) {
            const btn = row.components[c];
            console.log(`[BUTTON] Type:${btn.type} Label:"${btn.label}" CustomID:"${btn.customId}" Style:${btn.style}`);
            
            if (btn.type !== 2) {
                console.log(`[SKIP] Not a button (type ${btn.type})`);
                continue;
            }
            
            const label = (btn.label || '').toLowerCase();
            if (!label.includes('claim')) {
                console.log(`[SKIP] Label doesn't contain "claim": "${btn.label}"`);
                continue;
            }
            
            console.log(`[TARGET] Found Claim button!`);
            clickButton(message, btn);
            claimed = true;
        }
    }
    
    return claimed;
}

async function clickButton(message, btn) {
    console.log(`[CLICK] Attempting ${btn.customId}...`);
    
    // Method 1: Library's built-in
    try {
        console.log(`[METHOD 1] message.clickButton()`);
        await message.clickButton(btn.customId);
        console.log(`[SUCCESS] Method 1 worked!`);
        return;
    } catch (e) {
        console.error(`[FAIL 1] ${e.message}`);
    }
    
    // Method 2: Direct API call
    try {
        console.log(`[METHOD 2] Direct API call`);
        const res = await message.client.api.interactions.post({
            data: {
                type: 3,
                nonce: Date.now().toString(),
                guild_id: message.guildId,
                channel_id: message.channelId,
                message_id: message.id,
                application_id: message.applicationId || message.author.id,
                session_id: message.client.sessionId,
                data: {
                    component_type: 2,
                    custom_id: btn.customId
                }
            }
        });
        console.log(`[SUCCESS] Method 2 worked!`, res);
        return;
    } catch (e) {
        console.error(`[FAIL 2] ${e.message}`);
        if (e.response?.data) console.error(`[DETAIL]`, e.response.data);
    }
    
    // Method 3: Raw axios via client
    try {
        console.log(`[METHOD 3] HTTP POST`);
        const axios = require('axios');
        const res = await axios.post('https://discord.com/api/v9/interactions', {
            type: 3,
            nonce: Date.now().toString(),
            guild_id: message.guildId,
            channel_id: message.channelId,
            message_id: message.id,
            application_id: message.applicationId || message.author.id,
            session_id: message.client.sessionId,
            message_flags: message.flags?.bitfield || 0,
            data: {
                component_type: 2,
                custom_id: btn.customId
            }
        }, {
            headers: {
                'Authorization': USER_TOKEN,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        console.log(`[SUCCESS] Method 3 worked! Status: ${res.status}`);
    } catch (e) {
        console.error(`[FAIL 3] ${e.message}`);
        if (e.response) {
            console.error(`[STATUS] ${e.response.status}`);
            console.error(`[DATA]`, e.response.data);
        }
    }
}

client.on('error', console.error);
client.on('warn', console.warn);

client.login(USER_TOKEN).catch(e => {
    console.error(`[LOGIN FAIL] ${e.message}`);
    process.exit(1);
});
