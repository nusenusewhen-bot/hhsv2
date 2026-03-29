import discord
from discord import app_commands
from discord.ui import View, Button
import os
import asyncio

TOKEN = os.getenv('DISCORD_TOKEN')
# HARDCODED: All tickets go to this category
TICKET_CATEGORY_ID = 1485195520988418088

class TicketBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.guilds = True
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

    async def on_ready(self):
        print(f'✅ Bot logged in as {self.user}')
        print(f'📁 Ticket Category ID: {TICKET_CATEGORY_ID}')
        
        # Sync commands to ALL guilds instantly
        for guild in self.guilds:
            try:
                self.tree.copy_global_to(guild=guild)
                synced = await self.tree.sync(guild=guild)
                print(f'🔄 Synced {len(synced)} commands to {guild.name}')
            except Exception as e:
                print(f'❌ Failed to sync to {guild.name}: {e}')
        
        print('✅ Ready!')

client = TicketBot()

class TicketPanel(View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="🎫 Create Ticket", style=discord.ButtonStyle.primary, custom_id="create_ticket")
    async def create_ticket(self, interaction: discord.Interaction, button: Button):
        await interaction.response.defer(ephemeral=True)
        
        category = interaction.guild.get_channel(TICKET_CATEGORY_ID)
        if not category:
            await interaction.followup.send("❌ Ticket category not found! Check bot permissions.", ephemeral=True)
            return

        # Create ticket channel
        ticket_channel = await interaction.guild.create_text_channel(
            name=f"ticket-{interaction.user.name}",
            category=category,
            topic=f"Ticket by {interaction.user.id}"
        )

        # Set permissions - user can see it, everyone else can't
        await ticket_channel.set_permissions(interaction.guild.default_role, view_channel=False)
        await ticket_channel.set_permissions(interaction.user, view_channel=True, send_messages=True, read_message_history=True)

        # Send ticket message with Close and Claim buttons
        embed = discord.Embed(
            title="🎫 Support Ticket",
            description=f"Ticket created by {interaction.user.mention}\n\nStaff can use the buttons below:",
            color=discord.Color.blue()
        )
        
        view = TicketControls(interaction.user.id)
        await ticket_channel.send(embed=embed, view=view)
        await ticket_channel.send(f"{interaction.user.mention} Welcome! Please describe your issue.")

        await interaction.followup.send(f"✅ Ticket created: {ticket_channel.mention}", ephemeral=True)

class TicketControls(View):
    def __init__(self, creator_id):
        super().__init__(timeout=None)
        self.creator_id = creator_id
        self.claimed_by = None

    @discord.ui.button(label="🔒 Close", style=discord.ButtonStyle.danger, custom_id="close_ticket")
    async def close_ticket(self, interaction: discord.Interaction, button: Button):
        await interaction.response.send_message("🔒 Closing ticket in 5 seconds...")
        await asyncio.sleep(5)
        await interaction.channel.delete()

    @discord.ui.button(label="👋 Claim", style=discord.ButtonStyle.success, custom_id="claim_ticket")
    async def claim_ticket(self, interaction: discord.Interaction, button: Button):
        if self.claimed_by:
            await interaction.response.send_message(f"❌ Already claimed by {self.claimed_by.mention}", ephemeral=True)
            return

        self.claimed_by = interaction.user
        button.disabled = True
        button.label = f"Claimed by {interaction.user.name}"
        
        await interaction.response.edit_message(view=self)
        await interaction.channel.send(f"👋 **Claimed by {interaction.user.mention}**")

@client.tree.command(name="panel", description="Spawn the ticket creation panel")
async def panel(interaction: discord.Interaction):
    embed = discord.Embed(
        title="🎫 Support Tickets",
        description="Click the button below to create a support ticket!",
        color=discord.Color.green()
    )
    
    view = TicketPanel()
    await interaction.response.send_message(embed=embed, view=view)

if __name__ == "__main__":
    if not TOKEN:
        print("❌ DISCORD_TOKEN not found in environment variables!")
        print("Set DISCORD_TOKEN in Railway Variables")
    else:
        print("🚀 Starting bot...")
        client.run(TOKEN)
