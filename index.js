const { Client } = require('discord.js-selfbot-v13');
const superProperties = require('./superprops');

const client = new Client({
    checkUpdate: false,
    patchVoice: true,
    ws: {
        properties: superProperties
    },
    // Aggressive caching for speed
    messageCacheMaxSize: 100,
    messageCacheLifetime: 0,
    messageSweepInterval: 0
});

const CATEGORY_ID = process.env.CATEGORY_ID;
const USER_TOKEN = process.env.USER_TOKEN;

// Pre-allocated nonce generator for speed
let nonceCounter = BigInt(Date.now()) << BigInt(22);

client.on('ready', () => {
    console.log(`[READY] ${client.user.tag} | Monitoring: ${CATEGORY_ID}`);
});

// Raw WS handler for fastest possible detection
client.ws.on('MESSAGE_CREATE', async (packet) => {
    if (packet.guild_id && packet.channel_id) {
        const channel = await client.channels.fetch(packet.channel_id).catch(() => null);
        if (!channel || channel.parentId !== CATEGORY_ID) return;
        
        // Instant check for embeds with components
        if (!packet.components || packet.components.length === 0) return;
        
        // Fire all claim clicks immediately
        for (const row of packet.components) {
            for (const btn of row.components) {
                if (btn.type === 2 && btn.label?.toLowerCase().includes('claim')) {
                    fireClick(packet, btn);
                }
            }
        }
    }
});

async function fireClick(packet, button) {
    const nonce = (nonceCounter++).toString();
    
    const payload = {
        type: 3,
        nonce: nonce,
        guild_id: packet.guild_id,
        channel_id: packet.channel_id,
        message_id: packet.id,
        application_id: packet.application_id || packet.author?.id,
        session_id: client.sessionId,
        message_flags: packet.flags || 0,
        data: {
            component_type: 2,
            custom_id: button.custom_id
        }
    };

    // Direct WS send - no await, fire and forget
    client.ws.broadcast({
        op: 1,
        d: payload
    });
    
    console.log(`[CLAIM] ${nonce} | ${button.custom_id}`);
}

// Fallback message handler for cached messages
client.on('messageCreate', async (message) => {
    if (message.channel.parentId !== CATEGORY_ID) return;
    if (!message.components?.length) return;
    
    for (const row of message.components) {
        for (const btn of row.components) {
            if (btn.type === 2 && btn.label?.toLowerCase().includes('claim')) {
                message.clickButton(btn.customId).catch(() => {});
            }
        }
    }
});

client.login(USER_TOKEN);
