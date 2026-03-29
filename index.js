const { Client } = require('discord.js-selfbot-v13');

const client = new Client({
    checkUpdate: false
});

const CATEGORY_ID = process.env.CATEGORY_ID;
const USER_TOKEN = process.env.USER_TOKEN;

client.on('ready', () => {
    console.log(`[READY] ${client.user.tag}`);
    console.log(`[MONITOR] Category: ${CATEGORY_ID}`);
});

client.on('channelCreate', async (channel) => {
    if (channel.parentId !== CATEGORY_ID) return;
    
    console.log(`[NEW CHANNEL] ${channel.name}`);
    
    try {
        // Wait for message to arrive (ticket bots send msg after channel creation)
        await new Promise(r => setTimeout(r, 500));
        
        const messages = await channel.messages.fetch({ limit: 5 });
        
        for (const [, msg] of messages) {
            await processMessage(msg);
        }
    } catch (e) {
        console.error('[ERROR]', e.message);
    }
});

// Also catch messages in existing channels (backup)
client.on('messageCreate', async (message) => {
    if (message.channel.parentId !== CATEGORY_ID) return;
    await processMessage(message);
});

async function processMessage(message) {
    // Check for components (buttons)
    if (!message.components || message.components.length === 0) return;
    
    for (const row of message.components) {
        for (const component of row.components) {
            // Check if button label contains "Claim" (case insensitive)
            if (component.type === 2 && 
                component.label && 
                component.label.toLowerCase().includes('claim')) {
                
                console.log(`[FOUND] Claim button: "${component.label}" | customId: ${component.customId}`);
                
                try {
                    // Use the library's built-in clickButton method
                    await message.clickButton(component.customId);
                    console.log(`[CLICKED] ${component.customId}`);
                } catch (err) {
                    console.error(`[CLICK FAILED]`, err.message);
                }
            }
        }
    }
}

client.login(USER_TOKEN);
