const {
  Client, GatewayIntentBits, Partials, Events, AttachmentBuilder, ChannelType,
  ContainerBuilder, TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
  SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const http = require('http');
const path = require('path');
const fs = require('fs');

// =========================================
// ✅ CONFIG
// =========================================
const SERVER_ID = '1455418520501227558';

const UPLOAD_ROLE_IDS = [
  '1518477984405786634',
  '1518480188801814571',
  '1465009837120426212',
  '1548385700372676678',
  '1548387119226036386',
]; // members with ANY of these roles can use every command in this bot

const CHANNELS = {
  rev:          '1455476817170268235',
  citizen:      '1455476221902192664',
  carbine:      '1455477318389600450',
  nightCitizen: '1455483970786689158',
  ownCitizen:   '1528704162538192956',
  ownClothes:   '1528703477906145350',
  ownMinimap:   '1528703652267823287',
};

const WELCOME_CHANNEL_ID = '1455425200089858244';
const PARTNERS_CHANNEL_ID = '1525862751094702182';
const GIVEAWAY_CHANNEL_ID = '1550431924516818944';
const GIVEAWAY_ANNOUNCE_CHANNEL_ID = '1550432108978118716';
const AUTO_ROLE_ID = '1455419326038544477'; // given ONLY when someone clicks ✅ on the verify message (no longer automatic on join)
const VERIFY_CHANNEL_ID = '1455425112126914623';
const WELCOME_IMAGE_PATH = path.join(__dirname, 'welcome.gif');

// ===== TICKET SYSTEM CONFIG =====
const TICKET_PANEL_CHANNEL_ID = '1456157358899073226';       // where the Support + FamQ "open a ticket" panel is posted
const TICKET_PARTNERSHIP_PANEL_CHANNEL_ID = '1525862813275263046'; // where the standalone Partnership panel is posted
const TICKET_SUPPORT_FAMQ_CATEGORY_ID = '1456156764578906195'; // Support + FamQ tickets are created under this category
const TICKET_PARTNERSHIP_CATEGORY_ID = '1525862132451901470';  // Partnership tickets are created under this category
const TICKET_STAFF_ROLE_ID = '1518477984405786634';            // only this role (+ the creator) can see a ticket channel; also tagged on the Partnership panel
const TICKET_LOG_CHANNEL_ID = '1455514557417132145';           // closed-ticket transcripts/logs are posted here

// ===== ANTI-CHEAT WATCH CONFIG =====
const MOD_LOG_CHANNEL_ID = '1550777851996016680'; // timeout/ban info + remove-timeout/unban buttons
const ALERT_CHANNEL_ID = '1550778135925096538';    // keyword flags + join/leave alerts
const SPAM_PROTECTION_CHANNEL_ID = '1555631999643816026'; // messages here trigger a 1-hour timeout

// Messages in these channels are NEVER scanned for keywords/bad-servers —
// no flag, no timeout, no ban. Use this for a staff/mod-discussion channel
// where cheat servers get discussed openly without triggering punishment.
const ANTICHEAT_EXEMPT_CHANNEL_IDS = ['1456860128501436466'];

// /fixpermi grants exactly these permissions to the bot on every channel
// that's missing any of them.
const REQUIRED_CHANNEL_PERMS = {
  ViewChannel: true,
  SendMessages: true,
  EmbedLinks: true,
  AttachFiles: true,
  ReadMessageHistory: true,
  UseApplicationCommands: true,
  AddReactions: true,
};

// Case-insensitive substring match against every message in the server.
const FLAG_KEYWORDS = [
  '113 cheats', 'rage cheats', 'rage cheat', 'fivem cheats', 'fivem cheat',
  'hardware cheats', 'hardware cheat', 'dma cheats', 'dma cheat',
  'dms cheats', 'dms cheat', 'triggerbot', 'trigger bot', 'aimbot',
  'wallhack', 'esp cheat', 'cheat discord', 'cheats discord',
  'cheat server', 'cheat website', 'cheat seller', 'cheat',
];

const UPLOADER_TAG = '𝑽𝒊𝒄𝒊𝒐𝒖𝒔 𝑭𝒂𝒎𝑸'; // shown instead of the real uploader's name

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

function isStaff(member) {
  return !!member && member.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id));
}

// =========================================
// ✅ ANTI-CHEAT DATA (bad-server list + violation counts)
// =========================================
// Persisted to a JSON file so the bad-server list and strike counts survive
// a restart. On Railway, put this on a Volume (see setup notes) or it
// resets whenever the container redeploys — same caveat as any bot without
// a database.
const DATA_DIR = process.env.DATA_DIR || '.';
const DATA_FILE = path.join(DATA_DIR, 'anticheat.json');

function loadAntiCheatDB() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { badServers: {}, violations: {}, giveaways: {}, ...loaded };
  } catch {
    return { badServers: {}, violations: {}, giveaways: {} };
  }
}
function saveAntiCheatDB() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(acDB, null, 2));
  } catch (err) {
    console.error('❌ Failed to save anti-cheat DB:', err);
  }
}
let acDB = loadAntiCheatDB();

function findMatchedKeyword(text) {
  const lower = text.toLowerCase();
  return FLAG_KEYWORDS.find(kw => lower.includes(kw));
}

function findMatchedBadServer(text) {
  const lower = text.toLowerCase();
  for (const [identifier, info] of Object.entries(acDB.badServers)) {
    if (lower.includes(identifier)) return { identifier, ...info };
  }
  return null;
}

function recordViolation(userId) {
  acDB.violations[userId] = (acDB.violations[userId] || 0) + 1;
  saveAntiCheatDB();
  return acDB.violations[userId];
}

// =========================================
// ✅ SLASH COMMANDS
// =========================================
function buildUploadCommand(name, description) {
  const cmd = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption(o => o.setName('name').setDescription('Mod name').setRequired(true))
    .addStringOption(o => o.setName('link').setDescription('Download link').setRequired(true))
    .addStringOption(o => o.setName('password').setDescription('Password / password link').setRequired(true))
    .addStringOption(o => o.setName('filepath').setDescription('File path (optional)').setRequired(false))
    .addStringOption(o => o.setName('preview').setDescription('Preview link (optional) — auto-embeds a video card').setRequired(false));

  // Up to 5 screenshots, all optional.
  for (let i = 1; i <= 5; i++) {
    cmd.addAttachmentOption(o => o.setName(`screenshot${i}`).setDescription(`Preview screenshot/image ${i} (optional)`).setRequired(false));
  }
  return cmd;
}

const partnersCommand = new SlashCommandBuilder()
  .setName('partners')
  .setDescription('Post a partner ad — pastes your text exactly as-is (invite links auto-embed)')
  .addStringOption(o => o.setName('text').setDescription('The exact text to post').setRequired(true).setMaxLength(2000));

const giveawayCommand = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Start a giveaway in the giveaway channel')
  .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('How many minutes until it ends').setRequired(true).setMinValue(1))
  .addIntegerOption(o => o.setName('winners').setDescription('How many winners (default 1)').setRequired(false).setMinValue(1).setMaxValue(25));

const giveawayAnnounceCommand = new SlashCommandBuilder()
  .setName('giveawayannounce')
  .setDescription('Post a giveaway announcement — pastes your text exactly as-is')
  .addStringOption(o => o.setName('text').setDescription('The exact text to post').setRequired(true).setMaxLength(2000));

const addBadServerCommand = new SlashCommandBuilder()
  .setName('addbadserver')
  .setDescription('Add a banned server to the anti-cheat watch list')
  .addStringOption(o => o.setName('identifier').setDescription('Invite code (e.g. abc123) or a name/word to match').setRequired(true))
  .addStringOption(o => o.setName('label').setDescription('Display name shown in logs').setRequired(true));

const removeBadServerCommand = new SlashCommandBuilder()
  .setName('removebadserver')
  .setDescription('Remove a server from the anti-cheat watch list')
  .addStringOption(o => o.setName('identifier').setDescription('The exact identifier you added it with').setRequired(true));

const listBadServersCommand = new SlashCommandBuilder()
  .setName('listbadservers')
  .setDescription('List every server currently on the anti-cheat watch list');

const fixPermiCommand = new SlashCommandBuilder()
  .setName('fixpermi')
  .setDescription('Scan every channel and auto-fix any missing bot permissions');

const deleteRecentCommand = new SlashCommandBuilder()
  .setName('deleterecentmessages')
  .setDescription('Delete a user\'s messages from the last X minutes, across every channel')
  .addUserOption(o => o.setName('user').setDescription('The user whose messages to delete').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('How many minutes back to delete').setRequired(true).setMinValue(1).setMaxValue(20160));

const serverInfoCommand = new SlashCommandBuilder()
  .setName('serverinfo')
  .setDescription('Post the Server-Info navigation panel in this channel');

const sayCommand = new SlashCommandBuilder()
  .setName('say')
  .setDescription('Post your text in the same channel where this command is used')
  .addStringOption(o => o.setName('text').setDescription('The exact text to post').setRequired(true).setMaxLength(2000));

const commands = [
  buildUploadCommand('revupload', 'Post a new REV mod'),
  buildUploadCommand('citizenupload', 'Post a new Citizen mod'),
  buildUploadCommand('carbineupload', 'Post a new Carbine mod'),
  buildUploadCommand('nightcitizenupload', 'Post a new Night Citizen mod'),
  buildUploadCommand('owncitizenupload', 'Post a new Own Citizen mod'),
  buildUploadCommand('ownclothesupload', 'Post a new Own Clothes mod'),
  buildUploadCommand('ownminimapupload', 'Post a new Own Minimap mod'),
  partnersCommand,
  giveawayCommand,
  giveawayAnnounceCommand,
  addBadServerCommand,
  removeBadServerCommand,
  listBadServersCommand,
  fixPermiCommand,
  deleteRecentCommand,
  serverInfoCommand,
  sayCommand,
  new SlashCommandBuilder().setName('backup').setDescription('Download anticheat.json backup (Staff only)'),
].map(c => c.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, SERVER_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  await ensureVerifyMessage();
  await ensureTicketPanelMessage();
  await ensurePartnershipPanelMessage();
  await ensureSpamProtectionNotice();
  rehydrateGiveaways();
});

// =========================================
// ✅ VERIFY SYSTEM — private button click grants the access role
// =========================================
// Uses a button instead of a reaction so nobody can see who — or how many
// people — have verified (a reaction's face-pile + count is visible to
// everyone in the channel; a button click is only visible to the clicker).
async function ensureVerifyMessage() {
  try {
    const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);

    const container = new ContainerBuilder()
      .setAccentColor(0xF1C40F)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# ✅ Verify to Enter'),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          'Welcome to **Vicious FamQ**! Let\'s make some noise and show the world what FamQ is all about!\n\n' +
          'Click the button below to verify and unlock full access to the server.'
        ),
      );

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_button').setLabel('✅ Verify').setStyle(ButtonStyle.Success),
    );

    // Reuse the existing verify message across restarts instead of posting a
    // duplicate every time the bot comes back online — but if it's still the
    // old reaction-only version (no button), upgrade it in place and strip
    // the old reactions instead of leaving it as-is.
    if (acDB.verifyMessageId) {
      const existing = await channel.messages.fetch(acDB.verifyMessageId).catch(() => null);
      if (existing) {
        const hasVerifyButton = existing.components?.some(
          row => row.components?.some(c => c.customId === 'verify_button'),
        );
        if (!hasVerifyButton) {
          await existing.edit({ components: [container, buttonRow], flags: MessageFlags.IsComponentsV2 }).catch(err => {
            console.error('❌ Verify message upgrade failed:', err);
          });
          await existing.reactions.removeAll().catch(() => {});
        }
        return;
      }
    }

    const sent = await channel.send({ components: [container, buttonRow], flags: MessageFlags.IsComponentsV2 });

    acDB.verifyMessageId = sent.id;
    saveAntiCheatDB();
  } catch (err) {
    console.error('❌ Verify message setup failed:', err);
  }
}

// =========================================
// ✅ TICKET SYSTEM
// =========================================
const TICKET_TYPES = {
  partnership: { label: 'Partnership Ticket', emoji: '🤝', categoryId: TICKET_PARTNERSHIP_CATEGORY_ID, prefix: 'partnership', color: 0x3498DB },
  support:     { label: 'Support Ticket',     emoji: '🛠️', categoryId: TICKET_SUPPORT_FAMQ_CATEGORY_ID, prefix: 'support',     color: 0x2ECC71 },
  famq:        { label: 'FamQ Ticket',        emoji: '💀', categoryId: TICKET_SUPPORT_FAMQ_CATEGORY_ID, prefix: 'famq',        color: 0xF1C40F },
};

function buildTicketPanelContainer() {
  return new ContainerBuilder()
    .setAccentColor(0xF1C40F)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🎫 Vicious FamQ Support'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      'Having any issues or problems related to the Redux, Gun Pack, FamQ, or ModZ? Feel free to open a Ticket and let us know what\u2019s going on.\n\n' +
      'Our team will check your issue and do our best to help you out.\n\n' +
      '**Vicious FamQ Support — Always here to help!**\n\n' +
      '@here',
    ));
}

// Support + FamQ only — Partnership now lives on its own panel (see below).
function buildTicketPanelButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open_support').setLabel('Support Ticket').setEmoji('🛠️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket_open_famq').setLabel('FamQ Ticket').setEmoji('💀').setStyle(ButtonStyle.Secondary),
  );
}

function panelHasButton(message, customId) {
  return message.components?.some(row => row.components?.some(c => c.customId === customId));
}

// Reuses the existing panel message across restarts instead of reposting it.
// If it's still the old 3-button version (with Partnership on it), it gets
// upgraded in place to the new 2-button version instead of being left as-is.
async function ensureTicketPanelMessage() {
  try {
    const channel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID);

    if (acDB.ticketPanelMessageId) {
      const existing = await channel.messages.fetch(acDB.ticketPanelMessageId).catch(() => null);
      if (existing) {
        if (panelHasButton(existing, 'ticket_open_partnership')) {
          await existing.edit({
            components: [buildTicketPanelContainer(), buildTicketPanelButtonRow()],
            flags: MessageFlags.IsComponentsV2,
          }).catch(err => console.error('❌ Ticket panel upgrade failed:', err));
        }
        return;
      }
    }

    const sent = await channel.send({
      components: [buildTicketPanelContainer(), buildTicketPanelButtonRow()],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: ['everyone'] }, // needed for @here to actually ping
    });

    acDB.ticketPanelMessageId = sent.id;
    saveAntiCheatDB();
  } catch (err) {
    console.error('❌ Ticket panel setup failed:', err);
  }
}

function buildPartnershipPanelContainer() {
  return new ContainerBuilder()
    .setAccentColor(0x3498DB)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🤝 Vicious FamQ Partnerships'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      'Interested in partnering with **Vicious FamQ**? Feel free to open a Partnership Ticket and let us know what you have in mind.\n\n' +
      'Our team will check your request and do our best to help you out.\n\n' +
      '**Vicious FamQ Support — Always here to help!**',
    ));
}

function buildPartnershipPanelButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open_partnership').setLabel('Partnership Ticket').setEmoji('🤝').setStyle(ButtonStyle.Primary),
  );
}

// Reuses the existing panel message across restarts instead of reposting it.
// If it's still the old version with the role tag baked into the text, it
// gets upgraded in place instead of being left as-is.
async function ensurePartnershipPanelMessage() {
  try {
    const channel = await client.channels.fetch(TICKET_PARTNERSHIP_PANEL_CHANNEL_ID);

    if (acDB.partnershipPanelMessageId) {
      const existing = await channel.messages.fetch(acDB.partnershipPanelMessageId).catch(() => null);
      if (existing) {
        const stillHasRoleTag = existing.components?.some(
          comp => comp.components?.some(c => c.content?.includes(`<@&${TICKET_STAFF_ROLE_ID}>`)),
        );
        if (stillHasRoleTag) {
          await existing.edit({
            components: [buildPartnershipPanelContainer(), buildPartnershipPanelButtonRow()],
            flags: MessageFlags.IsComponentsV2,
          }).catch(err => console.error('❌ Partnership panel upgrade failed:', err));
        }
        return;
      }
    }

    const sent = await channel.send({
      components: [buildPartnershipPanelContainer(), buildPartnershipPanelButtonRow()],
      flags: MessageFlags.IsComponentsV2,
    });

    acDB.partnershipPanelMessageId = sent.id;
    saveAntiCheatDB();
  } catch (err) {
    console.error('❌ Partnership panel setup failed:', err);
  }
}

function sanitizeChannelName(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'user';
}

// Pulls every message in a channel, oldest first — used for transcripts.
async function fetchAllChannelMessages(channel) {
  const all = [];
  let beforeId;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(beforeId ? { before: beforeId } : {}) });
    if (batch.size === 0) break;
    all.push(...batch.values());
    beforeId = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Self-contained HTML transcript — includes every message's author, time,
// text content, and attachment links, so a closed ticket's full history
// stays readable even after the channel itself is deleted.
function buildTranscriptHtml({ guildName, channelName, channelId, messages }) {
  const rows = messages.map(m => `
    <div class="msg">
      <span class="author">${escapeHtml(m.authorTag)}</span>
      <span class="time">${new Date(m.timestamp).toLocaleString()}</span>
      <div class="content">${escapeHtml(m.content) || '<i>(no text content)</i>'}</div>
      ${m.attachments.length ? `<div class="attachments">${m.attachments.map(a => `📎 <a href="${a}">${escapeHtml(a)}</a>`).join('<br>')}</div>` : ''}
    </div>`).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Transcript - ${escapeHtml(channelName)}</title>
<style>
  body { background:#313338; color:#dbdee1; font-family:Whitney,Helvetica,Arial,sans-serif; padding:20px; }
  .header { border-bottom:1px solid #444; padding-bottom:10px; margin-bottom:20px; }
  .msg { padding:8px 0; border-bottom:1px solid #3a3b3e; }
  .author { font-weight:600; color:#f1c40f; margin-right:8px; }
  .time { font-size:11px; color:#949ba4; }
  .content { margin-top:2px; white-space:pre-wrap; word-wrap:break-word; }
  .attachments { margin-top:4px; font-size:12px; color:#00a8fc; }
</style></head>
<body>
  <div class="header">
    <h2>🎫 Transcript — #${escapeHtml(channelName)}</h2>
    <div>Server: ${escapeHtml(guildName)} • Channel ID: ${channelId}</div>
    <div>Messages: ${messages.length}</div>
  </div>
  ${rows || '<i>No messages.</i>'}
</body></html>`;
}

async function createTicketChannel(interaction, typeKey) {
  const type = TICKET_TYPES[typeKey];
  const guild = interaction.guild;

  // One open ticket of a given type per member at a time.
  acDB.tickets = acDB.tickets || {};
  const alreadyOpen = Object.entries(acDB.tickets).find(
    ([, t]) => !t.closed && t.creatorId === interaction.user.id && t.type === typeKey,
  );
  if (alreadyOpen) {
    const [existingChannelId] = alreadyOpen;
    // The record only means something if the channel is still actually
    // there — if it was deleted outside the bot's own Delete button (e.g.
    // manually, from Discord itself), the record goes stale and used to
    // block new tickets forever while pointing at a dead "#unknown" channel.
    const stillExists = await guild.channels.fetch(existingChannelId).catch(() => null);
    if (stillExists) {
      return interaction.reply({ content: `⚠️ You already have an open ${type.label.toLowerCase()}: <#${existingChannelId}>`, ephemeral: true });
    }
    delete acDB.tickets[existingChannelId];
    saveAntiCheatDB();
  }

  await interaction.deferReply({ ephemeral: true });

  const channelName = `${type.prefix}-${sanitizeChannelName(interaction.user.username)}`;

  let ticketChannel;
  try {
    ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: type.categoryId,
      // Only the ticket creator and the staff role can see the channel —
      // everyone else (including other members) is denied ViewChannel.
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
        { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles'] },
        { id: TICKET_STAFF_ROLE_ID, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'ManageMessages'] },
        { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'ManageChannels', 'ManageMessages'] },
      ],
      reason: `${type.label} opened by ${interaction.user.tag}`,
    });
  } catch (err) {
    console.error('❌ Ticket channel creation failed:', err);
    return interaction.editReply({ content: '❌ Couldn\'t create your ticket channel — check the bot\'s permissions on that category.' });
  }

  acDB.tickets[ticketChannel.id] = {
    type: typeKey,
    creatorId: interaction.user.id,
    creatorTag: interaction.user.tag,
    panelName: type.label,
    createdAt: Date.now(),
    closed: false,
  };
  saveAntiCheatDB();

  const welcomeContainer = new ContainerBuilder()
    .setAccentColor(type.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${interaction.user} • <@&${TICKET_STAFF_ROLE_ID}>`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${type.emoji} ${type.label}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `Welcome, ${interaction.user}! Thanks for reaching out to **Vicious FamQ Support Management**.\n\n` +
      'Please describe your issue in as much detail as you can — screenshots or clips help a lot.\n\n' +
      'A member of our support management team will be with you shortly. We appreciate your patience! 🙏',
    ));

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );

  // NOTE: a top-level `content` field is not allowed on a message that uses
  // MessageFlags.IsComponentsV2 (Discord rejects it with "Invalid Form Body" /
  // MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2) — the ping has to
  // live inside a TextDisplayComponent instead, as done above.
  await ticketChannel.send({
    components: [welcomeContainer, closeRow],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: [interaction.user.id], roles: [TICKET_STAFF_ROLE_ID] },
  });

  return interaction.editReply({ content: `✅ Your ticket has been created: ${ticketChannel}` });
}

async function closeTicket(interaction) {
  const ticket = acDB.tickets?.[interaction.channel.id];
  if (!ticket) return interaction.reply({ content: '⚠️ This channel isn\'t a recognized ticket.', ephemeral: true });
  if (ticket.closed) return interaction.reply({ content: '⚠️ This ticket is already closed.', ephemeral: true });

  const isCreator = interaction.user.id === ticket.creatorId;
  const isTicketStaff = isStaff(interaction.member) || interaction.member?.roles.cache.has(TICKET_STAFF_ROLE_ID);
  if (!isCreator && !isTicketStaff) {
    return interaction.reply({ content: '❌ You don\'t have permission to close this ticket.', ephemeral: true });
  }

  await interaction.deferReply();

  const rawMessages = await fetchAllChannelMessages(interaction.channel).catch(() => []);
  const messages = rawMessages.map(m => ({
    authorTag: m.author?.tag || 'Unknown',
    authorId: m.author?.id,
    content: m.content,
    timestamp: m.createdTimestamp,
    attachments: [...m.attachments.values()].map(a => a.url),
  }));

  const userCounts = new Map();
  for (const m of messages) {
    if (!m.authorId) continue;
    if (!userCounts.has(m.authorId)) userCounts.set(m.authorId, { tag: m.authorTag, count: 0 });
    userCounts.get(m.authorId).count += 1;
  }

  const html = buildTranscriptHtml({
    guildName: interaction.guild.name,
    channelName: interaction.channel.name,
    channelId: interaction.channel.id,
    messages,
  });
  const transcriptFile = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `transcript-${interaction.channel.name}.html` });

  ticket.closed = true;
  ticket.closedBy = interaction.user.id;
  ticket.closedAt = Date.now();
  saveAntiCheatDB();

  // Lock the channel — the creator keeps read access to history but can't send more.
  await interaction.channel.permissionOverwrites.edit(ticket.creatorId, { SendMessages: false }).catch(() => {});

  const closedContainer = new ContainerBuilder()
    .setAccentColor(0xE74C3C)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🔒 Ticket Closed by ${interaction.user}`));

  const closedButtonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_transcript').setLabel('Transcript').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket_reopen').setLabel('Open').setEmoji('🔓').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({
    components: [closedContainer, closedButtonsRow],
    flags: MessageFlags.IsComponentsV2,
  });

  // Full transcript + stats go to the ticket-log channel — kept even after the channel is deleted.
  try {
    const logChannel = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
    const usersLines = [...userCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, info]) => `${info.count} - <@${id}> (\`${info.tag}\`)`)
      .join('\n') || 'No participants recorded.';

    const infoBlock = [
      '```',
      '<Server-Info>',
      `    Server: ${interaction.guild.name} (${interaction.guild.id})`,
      `    Channel: ${interaction.channel.name} (${interaction.channel.id})`,
      `    Messages: ${messages.length}`,
      '```',
    ].join('\n');

    const logContainer = new ContainerBuilder()
      .setAccentColor(0x2ECC71)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(infoBlock))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**Ticket Owner:** <@${ticket.creatorId}> (\`${ticket.creatorTag}\`)\n` +
        `**Ticket Name:** ${interaction.channel.name}\n` +
        `**Panel Name:** ${ticket.panelName}\n\n` +
        `**Closed By:** ${interaction.user} (\`${interaction.user.tag}\`)\n\n` +
        `**Users in transcript:**\n${usersLines}`,
      ));

    await logChannel.send({ components: [logContainer], flags: MessageFlags.IsComponentsV2 });
    // Sent as a plain (non-Components-V2) message — Discord doesn't attach a
    // generic file to a Components V2 message unless it's referenced by a
    // component, so this needs to be its own regular message to actually show up.
    await logChannel.send({ content: `📄 Transcript for **${interaction.channel.name}**`, files: [transcriptFile] });
  } catch (err) {
    console.error('❌ Ticket log post failed:', err);
  }
}

// =========================================
// ✅ MESSAGE BUILDER
// =========================================
// Plain message content (not an embed) — this is what makes the big "#"
// heading, bold labels, and masked [text](url) links render at FULL size,
// exactly like the manual human posts. Embeds compress everything into a
// smaller box; plain content does not.
const GAP = '\u200b'; // zero-width space — Discord collapses truly-empty lines right after a "# heading", but not lines with invisible content like this.

function buildUploadContent({ name, link, password, preview, filepath }) {
  const lines = [
    `# ${name}`,
    GAP, GAP,
  ];

  if (filepath) {
    lines.push(`**File Path:** ${filepath}`, '', '');
  }

  lines.push(
    `**Link:** [Download](${link})`,
    '',
    '',
    `**Password:** ${password}`,
  );

  // A URL on its own line makes Discord auto-generate a real video preview
  // card underneath — the "Preview:" label doesn't break that, Discord still
  // detects and embeds the URL wherever it appears in the line.
  if (preview) {
    lines.push('', '', `**Preview:** ${preview}`);
  }

  lines.push('', `-# Uploaded by ${UPLOADER_TAG}`);
  return lines.join('\n');
}

// =========================================
// ✅ SERVER-INFO NAVIGATION PANEL
// =========================================
function buildServerInfoContainer() {
  const sep = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large);
  const td = (text) => new TextDisplayBuilder().setContent(text);

  const container = new ContainerBuilder().setAccentColor(0x5865F2);

  container.addTextDisplayComponents(td(
    '# 📖 | SERVER-INFO\n\n' +
    '> **Welcome to the server. 👑**\n' +
    '> Everything you need is organized below. Use the navigation channels according to their purpose and keep the community clean, active and enjoyable.'
  ));

  container.addSeparatorComponents(sep());
  container.addTextDisplayComponents(td(
    '## 🆕 | NEW ARRIVAL\n\n' +
    '### ✨ <#1455425200089858244>\n→ New members start here. Welcome message and basic introduction.\n\n' +
    '### 📜 <#1473896479474323643>\n→ Important server announcements, updates and news.\n\n' +
    '### 📋 <#1455444974735720569>\n→ Server rules, guidelines and important information.\n\n' +
    '### 🛩️ <#1455425112126914623>\n→ Member verification.\n\n' +
    '### 🎮 <#1456096192504008704>\n→ Free games and related gaming posts.\n\n' +
    '### 🎭 <#1455418521440878644>\n→ General community conversation and chatting.'
  ));

  container.addSeparatorComponents(sep());
  container.addTextDisplayComponents(td(
    '## 🎉 | GIVEAWAYS\n\n' +
    '### 🎉 <#1518206817384271973>\n→ Member/customer reviews and feedback.\n\n' +
    '### 🎉 <#1550432108978118716>\n→ Giveaway announcements and information.'
  ));

  container.addSeparatorComponents(sep());
  container.addTextDisplayComponents(td(
    '## 🎥 | MEDIA\n\n' +
    '### 🎥 <#1455443694261113065>\n→ Public media/content sharing.\n\n' +
    '### 🎬 <#1548357745390919771>\n→ Content creators and their work.\n\n' +
    '### 🏅 <#1455443788469244017>\n→ Vicious-FamQ media/content.\n\n' +
    '### 🎬 <#1476187845914918952>\n→ Reels and short-form media.'
  ));

  container.addSeparatorComponents(sep());
  container.addTextDisplayComponents(td(
    '## 🤝 | PARTNERS\n\n' +
    '### 📮 <#1525862695234965656>\n→ Partnership template/information.\n\n' +
    '### 🤝 <#1525862751094702182>\n→ Partner servers/community information.\n\n' +
    '### 🎟️ <#1525862813275263046>\n→ Partnership requests/tickets.'
  ));

  container.addSeparatorComponents(sep());
  container.addTextDisplayComponents(td(
    '## 👥 | HELP SECTION\n\n' +
    '### 📩 <#1456157358899073226>\n→ Open a support ticket when you need assistance.'
  ));

  return container;
}

// =========================================
// ✅ WELCOME MESSAGE (new member joins)
// =========================================
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== SERVER_ID) return;

  try {
    const channel = await client.channels.fetch(WELCOME_CHANNEL_ID);
    const welcomeImage = new AttachmentBuilder(WELCOME_IMAGE_PATH, { name: 'welcome.gif' });

    const container = new ContainerBuilder()
      .setAccentColor(0xF1C40F)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`〽️ Welcome ${member} to the Vicious FamQ❤️`),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# Vicious FamQ💀'),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '〽️Welcome to the Vicious FamQ❤️, ' + `${member}` + '!\n' +
          '✨You’re now part of something legendary.✨\n' +
          '🎗️ Get ready for epic vibes, dope chats, and a community that has your back.🎖️\n' +
          '♣️  Check out the channels, meet the crew, and most importantly… Have fun! 🍹'
        ),
      )
      .addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL('attachment://welcome.gif'),
        ),
      );

    await channel.send({
      components: [container],
      files: [welcomeImage],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.error('❌ Welcome message failed:', err);
  }

  // Anti-cheat watch — join alert
  try {
    const alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
    await alertChannel.send({
      content: `📥 **Joined:** ${member} (\`${member.user.tag}\`, \`${member.id}\`) — <t:${Math.floor(Date.now() / 1000)}:F>`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('❌ Join alert failed:', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (member.guild.id !== SERVER_ID) return;
  try {
    const alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
    await alertChannel.send({
      content: `📤 **Left:** \`${member.user?.tag || member.id}\` (\`${member.id}\`) — <t:${Math.floor(Date.now() / 1000)}:F>`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('❌ Leave alert failed:', err);
  }

  // Auto-reroll — if this member was the winner of any ended giveaway,
  // replace them with a new winner right away.
  try {
    for (const giveawayId of Object.keys(acDB.giveaways || {})) {
      const g = acDB.giveaways[giveawayId];
      if (g.ended && g.winners?.includes(member.id)) {
        await rerollSingleWinner(giveawayId, member.id);
      }
    }
  } catch (err) {
    console.error('❌ Auto-reroll-on-leave failed:', err);
  }
});

// Keeps the ticket DB in sync the moment a ticket channel disappears, no
// matter how it was deleted (our own Delete button, or manually from
// Discord) — without this, a stale record blocks that member from ever
// opening a new ticket of the same type again.
client.on(Events.ChannelDelete, async (channel) => {
  try {
    if (acDB.tickets && acDB.tickets[channel.id]) {
      delete acDB.tickets[channel.id];
      saveAntiCheatDB();
    }
  } catch (err) {
    console.error('❌ Ticket cleanup on channel delete failed:', err);
  }
});

// =========================================
// ✅ ANTI-CHEAT WATCH — punishment + logging
// =========================================
function buildModLogContainer({ userId, userTag, strike, actionLabel, reason, matchedText, sourceChannelId, messageUrl }) {
  const accentColor = strike >= 3 ? 0xE74C3C : strike === 2 ? 0xE67E22 : 0xF1C40F;
  const lines = [
    `**User:** <@${userId}> (\`${userTag}\`, \`${userId}\`)`,
    '',
    `**Strike:** ${strike}`,
    '',
    `**Action:** ${actionLabel}`,
    '',
    `**Reason:** ${reason}`,
    '',
    `**Matched Text:** \`${matchedText}\``,
    '',
    `**Channel:** <#${sourceChannelId}>${messageUrl ? ` • [Jump to message](${messageUrl})` : ''}`,
    '',
    `-# <t:${Math.floor(Date.now() / 1000)}:F>`,
  ];

  return new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(strike >= 3 ? '# 🔨 Ban Issued' : '# ⏱️ Timeout Issued'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

function buildModLogButtonRow(userId, wasBan) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(wasBan ? `modlog_unban_${userId}` : `modlog_removetimeout_${userId}`)
      .setLabel(wasBan ? '🔓 Unban' : '⏱️ Remove Timeout')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function buildPunishmentDMText(strike, reason) {
  if (strike === 1) {
    return (
      `⚠️ **You have been timed out in Vicious FamQ for 5 minutes.**\n\n` +
      `**Reason:** ${reason}\n\n` +
      `If you do this again, you will be timed out again for 10 minutes.`
    );
  }
  if (strike === 2) {
    return (
      `⚠️ **You have been timed out in Vicious FamQ for 10 minutes.**\n\n` +
      `**Reason:** ${reason}\n\n` +
      `If you do this again, you will be banned from the server.`
    );
  }
  return (
    `⛔ **You have been banned from Vicious FamQ.**\n\n` +
    `**Reason:** ${reason}`
  );
}

async function applyPunishment(member, strike, reason, matchedText, sourceChannelId, messageUrl) {
  let actionLabel;
  let wasBan = false;

  // DM before the action — a banned member can no longer reliably be DM'd
  // afterward, so this has to happen first.
  await member.send(await buildPunishmentDMText(strike, reason)).catch(() => {});

  try {
    if (strike === 1) {
      actionLabel = 'Timeout — 5 minutes';
      await member.timeout(5 * 60 * 1000, reason);
    } else if (strike === 2) {
      actionLabel = 'Timeout — 10 minutes';
      await member.timeout(10 * 60 * 1000, reason);
    } else {
      actionLabel = 'Ban';
      wasBan = true;
      await member.ban({ reason });
    }
  } catch (err) {
    console.error('❌ Punishment action failed:', err);
    actionLabel = `${actionLabel || 'Action'} (⚠️ FAILED — check bot permissions/role position)`;
  }

  try {
    const logChannel = await client.channels.fetch(MOD_LOG_CHANNEL_ID);
    await logChannel.send({
      components: [
        buildModLogContainer({
          userId: member.id,
          userTag: member.user.tag,
          strike,
          actionLabel,
          reason,
          matchedText,
          sourceChannelId,
          messageUrl,
        }),
        buildModLogButtonRow(member.id, wasBan),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.error('❌ Mod log post failed:', err);
  }
}

// =========================================
// SPAM PROTECTION CHANNEL
// =========================================
async function ensureSpamProtectionNotice() {
  try {
    const channel = await client.channels.fetch(SPAM_PROTECTION_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    const noticeText = '# DO NOT SEND MESSAGES IN THIS CHANNEL\n- This channel is used to catch spam bots. Any messages sent here will result in a timeout.';
    if (acDB.spamProtectionNoticeMessageId) {
      const existing = await channel.messages.fetch(acDB.spamProtectionNoticeMessageId).catch(() => null);
      if (existing) return;
    }

    const sent = await channel.send({ content: noticeText, allowedMentions: { parse: [] } });
    acDB.spamProtectionNoticeMessageId = sent.id;
    saveAntiCheatDB();
  } catch (err) {
    console.error('❌ Spam-protection notice setup failed:', err);
  }
}

async function deleteUserMessagesFromLastTwoMinutes(guild, userId) {
  const cutoff = Date.now() - (2 * 60 * 1000);
  let deleted = 0;

  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased() || !channel.messages) continue;

    try {
      let before;
      while (true) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;

        const messages = [...batch.values()];
        const relevant = messages.filter(m => m.author?.id === userId && m.createdTimestamp >= cutoff);
        if (relevant.length) {
          const results = await Promise.allSettled(relevant.map(m => m.delete()));
          deleted += results.filter(r => r.status === 'fulfilled').length;
        }

        const oldest = messages.reduce((a, b) => a.createdTimestamp < b.createdTimestamp ? a : b);
        if (oldest.createdTimestamp < cutoff || batch.size < 100) break;
        before = oldest.id;
      }
    } catch (err) {
      // Some channels (e.g. private channels without bot access) may not be readable.
      console.error(`❌ Spam cleanup failed in channel ${channel.id}:`, err.message);
    }
  }

  return deleted;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.guild?.id !== SERVER_ID) return;
  if (message.author.bot) return;

  // This rule runs before all other message filters: any member posting here
  // receives a one-hour timeout and has their recent messages removed.
  if (message.channel.id === SPAM_PROTECTION_CHANNEL_ID) {
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    await message.delete().catch(err => console.error('❌ Failed to delete spam-channel message:', err));

    if (!member) return;
    const reason = 'Spam protection: message sent in the designated spam-bot detection channel.';
    try {
      await member.timeout(60 * 60 * 1000, reason);
    } catch (err) {
      console.error('❌ Spam-protection timeout failed:', err);
    }

    const deletedCount = await deleteUserMessagesFromLastTwoMinutes(message.guild, message.author.id);

    // Send a moderation log with the same Remove Timeout button used by other punishments.
    // The button is restricted by isStaff(), which checks the bot-access role list.
    try {
      const logChannel = await client.channels.fetch(MOD_LOG_CHANNEL_ID);
      const logContainer = buildModLogContainer({
        userId: message.author.id,
        userTag: message.author.tag,
        strike: 1,
        actionLabel: 'Timeout — 1 hour (spam-protection channel)',
        reason,
        matchedText: message.content || '[non-text message]',
        sourceChannelId: SPAM_PROTECTION_CHANNEL_ID,
        messageUrl: null,
      });
      logContainer.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Recent messages deleted:** ${deletedCount}`));
      await logChannel.send({
        components: [logContainer, buildModLogButtonRow(message.author.id, false)],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (err) {
      console.error('❌ Spam-protection moderation log failed:', err);
    }

    try {
      const channel = await client.channels.fetch(SPAM_PROTECTION_CHANNEL_ID);
      await channel.send({
        content: `⏱️ ${message.author} was timed out for **1 hour** because they sent a message in this channel.\n**Reason:** ${reason}\n🧹 Removed ${deletedCount} recent message(s) from this user where the bot had permission.`,
        allowedMentions: { users: [] },
      });
    } catch (err) {
      console.error('❌ Spam-protection notice message failed:', err);
    }
    return;
  }

  if (!message.content) return;
  if (ANTICHEAT_EXEMPT_CHANNEL_IDS.includes(message.channel.id)) return;
  if (isStaff(message.member)) return; // staff/bot-access roles are exempt from anti-cheat entirely

  const keywordMatch = findMatchedKeyword(message.content);
  const badServerMatch = findMatchedBadServer(message.content);
  if (!keywordMatch && !badServerMatch) return;

  const matchedText = keywordMatch || badServerMatch.identifier;
  const reason = keywordMatch
    ? `Suspicious keyword: "${keywordMatch}"`
    : `Reference to banned server: "${badServerMatch.label}"`;

  // Alert first, regardless of whether the punishment step succeeds.
  try {
    const alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
    await alertChannel.send({
      content:
        `🚩 **Flagged Message**\n` +
        `**User:** ${message.author} (\`${message.author.tag}\`, \`${message.author.id}\`)\n` +
        `**Channel:** <#${message.channel.id}>\n` +
        `**Matched:** \`${matchedText}\`\n` +
        `**Message:** ${message.content.slice(0, 1000)}\n` +
        `[Jump to message](${message.url})`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('❌ Flag alert post failed:', err);
  }

  // Remove the flagged message itself — previously only the punishment
  // (timeout/ban) happened and the message was left visible in the channel.
  await message.delete().catch(err => console.error('❌ Failed to delete flagged message:', err));

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  const strike = recordViolation(message.author.id);
  await applyPunishment(member, strike, reason, matchedText, message.channel.id, message.url);
});

// =========================================
// ✅ GIVEAWAY SYSTEM
// =========================================
// In-memory only — a giveaway still running when the bot restarts will be
// lost (no database in this bot). Fine for short/medium giveaways.
const giveaways = new Map(); // giveawayId -> { prize, endsAt, winnersCount, participants: Set<userId>, channelId, messageId, ended, hostId, winners }
const giveawayTimers = new Map();

// Giveaways survive a restart via the same JSON file as the anti-cheat data.
// participants is a Set at runtime (fast lookups) but stored as an array.
function persistGiveaway(giveawayId) {
  const g = giveaways.get(giveawayId);
  if (!g) return;
  acDB.giveaways[giveawayId] = { ...g, participants: [...g.participants] };
  saveAntiCheatDB();
}

// Runs once on startup — restores any giveaway that was still running when
// the bot last stopped, and picks up exactly where it left off. One still
// ended while the bot was offline gets its winners drawn immediately.
function rehydrateGiveaways() {
  for (const [giveawayId, saved] of Object.entries(acDB.giveaways || {})) {
    if (saved.ended) {
      // Already finished before this restart — just refresh its message so
      // it picks up any button changes (like Reroll) added since it ended.
      const g = { ...saved, participants: new Set(saved.participants) };
      updateGiveawayMessage(g, giveawayId).catch(err => console.error('❌ Ended-giveaway refresh failed:', err));
      continue;
    }

    giveaways.set(giveawayId, { ...saved, participants: new Set(saved.participants) });

    const remaining = saved.endsAt - Date.now();
    if (remaining <= 0) {
      endGiveaway(giveawayId).catch(err => console.error('❌ Giveaway catch-up end failed:', err));
    } else {
      scheduleGiveawayEnd(giveawayId, remaining);
    }
  }
}

function buildGiveawayContainer(giveaway) {
  const entryCount = giveaway.participants.size;
  const endsUnix = Math.floor(giveaway.endsAt / 1000);

  const lines = giveaway.ended
    ? [
        `**Prize:** ${giveaway.prize}`,
        '',
        `**Ended:** <t:${endsUnix}:R>`,
        '',
        giveaway.winners.length
          ? `**Winner${giveaway.winners.length > 1 ? 's' : ''}:** ${giveaway.winners.map(id => `<@${id}>`).join(', ')}`
          : '**Winners:** No one entered 😢',
      ]
    : [
        `**Prize:** ${giveaway.prize}`,
        '',
        `**Winners:** ${giveaway.winnersCount}`,
        '',
        `**Ends:** <t:${endsUnix}:R> (<t:${endsUnix}:F>)`,
        '',
        `**Entries:** ${entryCount}`,
      ];

  return new ContainerBuilder()
    .setAccentColor(giveaway.ended ? 0x99AAB5 : 0xF1C40F)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('@everyone'),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(giveaway.ended ? '# 🎉 GIVEAWAY ENDED 🎉' : '# 🎉 GIVEAWAY 🎉'),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        giveaway.ended
          ? `-# Hosted by <@${giveaway.hostId}>`
          : `-# Click the button below to enter! • Hosted by <@${giveaway.hostId}>`,
      ),
    );
}

function buildGiveawayButtonRow(giveawayId, ended) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter_${giveawayId}`)
      .setLabel(ended ? 'Giveaway Ended' : '🎉 Enter Giveaway')
      .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(ended),
    new ButtonBuilder()
      .setCustomId(`giveaway_entries_${giveawayId}`)
      .setLabel('👥 View Entries')
      .setStyle(ButtonStyle.Secondary),
  );
  if (ended) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_reroll_${giveawayId}`)
        .setLabel('🔄 Reroll')
        .setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

// --- Reroll helpers (operate on the persisted copy so this still works
// after a restart, even for giveaways no longer in the in-memory Map) ---
function getStoredGiveaway(giveawayId) {
  const saved = acDB.giveaways[giveawayId];
  if (!saved) return null;
  return { ...saved, participants: new Set(saved.participants) };
}

function saveStoredGiveaway(giveawayId, g) {
  acDB.giveaways[giveawayId] = { ...g, participants: [...g.participants] };
  saveAntiCheatDB();
  if (giveaways.has(giveawayId)) giveaways.set(giveawayId, g); // keep in-memory copy in sync too
}

async function updateGiveawayMessage(g, giveawayId) {
  try {
    const channel = await client.channels.fetch(g.channelId);
    const msg = await channel.messages.fetch(g.messageId);
    await msg.edit({
      components: [buildGiveawayContainer(g), buildGiveawayButtonRow(giveawayId, true)],
      flags: MessageFlags.IsComponentsV2,
    });
    return channel;
  } catch (err) {
    console.error('❌ Giveaway message update failed:', err);
    return null;
  }
}

// Full reroll — picks a brand new set of winners from everyone who entered.
async function fullRerollGiveaway(giveawayId) {
  const g = getStoredGiveaway(giveawayId);
  if (!g || !g.ended) return null;

  const pool = [...g.participants];
  const winners = [];
  while (winners.length < g.winnersCount && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  g.winners = winners;
  saveStoredGiveaway(giveawayId, g);

  const channel = await updateGiveawayMessage(g, giveawayId);
  if (channel) {
    if (winners.length) {
      await channel.send({
        content: `🔄 **Reroll!** New winner${winners.length > 1 ? 's' : ''} for **${g.prize}**: ${winners.map(id => `<@${id}>`).join(', ')} 🎉`,
        allowedMentions: { users: winners },
      }).catch(() => {});
    } else {
      await channel.send({ content: `🔄 Reroll attempted for **${g.prize}**, but there were no entrants.` }).catch(() => {});
    }
  }
  return winners;
}

// Targeted reroll — replaces one specific winner (used when a winner leaves
// the server) without disturbing the other winners.
async function rerollSingleWinner(giveawayId, leavingUserId) {
  const g = getStoredGiveaway(giveawayId);
  if (!g || !g.ended || !g.winners.includes(leavingUserId)) return null;

  const pool = [...g.participants].filter(id => id !== leavingUserId && !g.winners.includes(id));
  g.winners = g.winners.filter(id => id !== leavingUserId);

  let newWinnerId = null;
  if (pool.length > 0) {
    newWinnerId = pool[Math.floor(Math.random() * pool.length)];
    g.winners.push(newWinnerId);
  }
  saveStoredGiveaway(giveawayId, g);

  const channel = await updateGiveawayMessage(g, giveawayId);
  if (channel) {
    if (newWinnerId) {
      await channel.send({
        content: `🔄 <@${leavingUserId}> left the server, so a new winner was drawn for **${g.prize}**!\n🎉 Congratulations <@${newWinnerId}>! **You are the winner!**`,
        allowedMentions: { users: [newWinnerId] },
      }).catch(() => {});
    } else {
      await channel.send({ content: `🔄 <@${leavingUserId}> left the server, but there were no other entrants to reroll for **${g.prize}**.` }).catch(() => {});
    }
  }
  return newWinnerId;
}

function scheduleGiveawayEnd(giveawayId, delayMs) {
  if (giveawayTimers.has(giveawayId)) clearTimeout(giveawayTimers.get(giveawayId));
  const timer = setTimeout(() => endGiveaway(giveawayId).catch(err => console.error('❌ Giveaway end failed:', err)), delayMs);
  giveawayTimers.set(giveawayId, timer);
}

async function endGiveaway(giveawayId) {
  const giveaway = giveaways.get(giveawayId);
  if (!giveaway || giveaway.ended) return;

  const pool = [...giveaway.participants];
  const winners = [];
  while (winners.length < giveaway.winnersCount && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }

  giveaway.ended = true;
  giveaway.winners = winners;
  persistGiveaway(giveawayId);
  if (giveawayTimers.has(giveawayId)) { clearTimeout(giveawayTimers.get(giveawayId)); giveawayTimers.delete(giveawayId); }

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const msg = await channel.messages.fetch(giveaway.messageId);
    await msg.edit({
      components: [buildGiveawayContainer(giveaway), buildGiveawayButtonRow(giveawayId, true)],
      flags: MessageFlags.IsComponentsV2,
    });

    if (winners.length) {
      await channel.send({
        content: `🎉 Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! **You are the winner${winners.length > 1 ? 's' : ''}** of **${giveaway.prize}**!`,
        allowedMentions: { users: winners },
      });

      // Automatically tell the winner(s) to open a support ticket to claim the prize.
      await channel.send({
        content: `${winners.map(id => `<@${id}>`).join(', ')} Make a <#1456157358899073226> For Claim Your Prize and Tag me. Congrats ❤️`,
        allowedMentions: { users: winners },
      });
    } else {
      await channel.send({ content: `😢 No one entered the giveaway for **${giveaway.prize}** — no winner this time.` });
    }
  } catch (err) {
    console.error('❌ Giveaway end message failed:', err);
  }
}

// =========================================
// ✅ COMMAND HANDLER
// =========================================
const COMMAND_CHANNEL_MAP = {
  revupload: CHANNELS.rev,
  citizenupload: CHANNELS.citizen,
  carbineupload: CHANNELS.carbine,
  nightcitizenupload: CHANNELS.nightCitizen,
  owncitizenupload: CHANNELS.ownCitizen,
  ownclothesupload: CHANNELS.ownClothes,
  ownminimapupload: CHANNELS.ownMinimap,
};

client.on(Events.InteractionCreate, async (interaction) => {
 try {
  // --- Verify button — grants the access role privately (no public count) ---
  if (interaction.isButton() && interaction.customId === 'verify_button') {
    const guild = await client.guilds.fetch(SERVER_ID);
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return interaction.reply({ content: '⚠️ Couldn\'t verify you — try again in a moment.', ephemeral: true });

    if (member.roles.cache.has(AUTO_ROLE_ID)) {
      return interaction.reply({ content: '✅ You\'re already verified.', ephemeral: true });
    }
    await member.roles.add(AUTO_ROLE_ID).catch(err => console.error('❌ Verify role assign failed:', err));
    return interaction.reply({ content: '✅ You\'ve been verified! Welcome to Vicious FamQ.', ephemeral: true });
  }

  // --- Ticket panel buttons — open a new private ticket channel ---
  if (interaction.isButton() && interaction.customId.startsWith('ticket_open_')) {
    const typeKey = interaction.customId.replace('ticket_open_', '');
    if (!TICKET_TYPES[typeKey]) return;
    return createTicketChannel(interaction, typeKey);
  }

  // --- Close Ticket button — creator or staff only ---
  if (interaction.isButton() && interaction.customId === 'ticket_close') {
    return closeTicket(interaction);
  }

  // --- Post-close: Transcript / Open / Delete buttons ---
  if (interaction.isButton() && interaction.customId === 'ticket_transcript') {
    const ticket = acDB.tickets?.[interaction.channel.id];
    if (!ticket) return interaction.reply({ content: '⚠️ This channel isn\'t a recognized ticket.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });
    const rawMessages = await fetchAllChannelMessages(interaction.channel).catch(() => []);
    const messages = rawMessages.map(m => ({
      authorTag: m.author?.tag || 'Unknown',
      content: m.content,
      timestamp: m.createdTimestamp,
      attachments: [...m.attachments.values()].map(a => a.url),
    }));
    const html = buildTranscriptHtml({
      guildName: interaction.guild.name,
      channelName: interaction.channel.name,
      channelId: interaction.channel.id,
      messages,
    });
    const file = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `transcript-${interaction.channel.name}.html` });
    return interaction.editReply({ files: [file] });
  }

  if (interaction.isButton() && interaction.customId === 'ticket_reopen') {
    const ticket = acDB.tickets?.[interaction.channel.id];
    if (!ticket) return interaction.reply({ content: '⚠️ This channel isn\'t a recognized ticket.', ephemeral: true });
    if (!isStaff(interaction.member) && !interaction.member?.roles.cache.has(TICKET_STAFF_ROLE_ID)) {
      return interaction.reply({ content: '❌ Only staff can reopen a ticket.', ephemeral: true });
    }
    ticket.closed = false;
    delete ticket.closedBy;
    delete ticket.closedAt;
    saveAntiCheatDB();
    await interaction.channel.permissionOverwrites.edit(ticket.creatorId, { SendMessages: true }).catch(() => {});
    return interaction.reply({ content: `🔓 Ticket reopened by ${interaction.user}.` });
  }

  if (interaction.isButton() && interaction.customId === 'ticket_delete') {
    const ticket = acDB.tickets?.[interaction.channel.id];
    if (!ticket) return interaction.reply({ content: '⚠️ This channel isn\'t a recognized ticket.', ephemeral: true });
    if (!isStaff(interaction.member) && !interaction.member?.roles.cache.has(TICKET_STAFF_ROLE_ID)) {
      return interaction.reply({ content: '❌ Only staff can delete a ticket.', ephemeral: true });
    }
    await interaction.reply({ content: '🗑️ Deleting this ticket in 5 seconds…' });
    const channelId = interaction.channel.id;
    setTimeout(async () => {
      try {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) await ch.delete(`Ticket deleted by ${interaction.user.tag}`);
      } catch (err) {
        console.error('❌ Ticket delete failed:', err);
      } finally {
        if (acDB.tickets) delete acDB.tickets[channelId];
        saveAntiCheatDB();
      }
    }, 5000);
    return;
  }

  // --- Giveaway "Enter" button — open to everyone, no role check ---
  if (interaction.isButton() && interaction.customId.startsWith('giveaway_enter_')) {
    const giveawayId = interaction.customId.replace('giveaway_enter_', '');
    const giveaway = giveaways.get(giveawayId);
    if (!giveaway) return interaction.reply({ content: '⚠️ This giveaway no longer exists.', ephemeral: true });
    if (giveaway.ended) return interaction.reply({ content: '⚠️ This giveaway has already ended.', ephemeral: true });

    if (giveaway.participants.has(interaction.user.id)) {
      return interaction.reply({ content: '✅ You\'re already entered!', ephemeral: true });
    }
    giveaway.participants.add(interaction.user.id);
    persistGiveaway(giveawayId);

    await interaction.update({
      components: [buildGiveawayContainer(giveaway), buildGiveawayButtonRow(giveawayId, false)],
      flags: MessageFlags.IsComponentsV2,
    });
    return interaction.followUp({ content: '🎉 You\'re entered! Good luck!', ephemeral: true });
  }

  // --- Giveaway "View Entries" button — only members with a bot-use role ---
  if (interaction.isButton() && interaction.customId.startsWith('giveaway_entries_')) {
    const giveawayId = interaction.customId.replace('giveaway_entries_', '');
    const giveaway = giveaways.get(giveawayId);
    if (!giveaway) return interaction.reply({ content: '⚠️ This giveaway no longer exists.', ephemeral: true });

    if (!interaction.member?.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id))) {
      return interaction.reply({ content: '❌ You don\'t have permission to view entries.', ephemeral: true });
    }

    const entrants = [...giveaway.participants];
    let list = entrants.length
      ? entrants.map((id, i) => `${i + 1}. <@${id}>`).join('\n')
      : 'No one has entered yet.';

    // Guard against Discord's 2000-char message limit for very large giveaways.
    if (list.length > 1800) {
      const truncated = [];
      let len = 0;
      for (const line of list.split('\n')) {
        if (len + line.length > 1700) break;
        truncated.push(line);
        len += line.length + 1;
      }
      list = truncated.join('\n') + `\n… and ${entrants.length - truncated.length} more`;
    }

    return interaction.reply({
      content: `👥 **Entries for "${giveaway.prize}"** (${entrants.length} total)\n\n${list}`,
      ephemeral: true,
    });
  }

  // --- Giveaway "Reroll" button — staff only, draws a fresh set of winners ---
  if (interaction.isButton() && interaction.customId.startsWith('giveaway_reroll_')) {
    const giveawayId = interaction.customId.replace('giveaway_reroll_', '');

    if (!interaction.member?.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id))) {
      return interaction.reply({ content: '❌ Only staff can reroll a giveaway.', ephemeral: true });
    }

    const winners = await fullRerollGiveaway(giveawayId);
    if (winners === null) {
      return interaction.reply({ content: '⚠️ This giveaway no longer exists or hasn\'t ended yet.', ephemeral: true });
    }
    return interaction.reply({ content: '✅ Rerolled!', ephemeral: true });
  }

  // --- Mod log "Remove Timeout" / "Unban" buttons — staff only, opens a reason modal ---
  if (interaction.isButton() && (interaction.customId.startsWith('modlog_removetimeout_') || interaction.customId.startsWith('modlog_unban_'))) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '❌ Only staff can do this.', ephemeral: true });
    }

    const isUnban = interaction.customId.startsWith('modlog_unban_');
    const userId = interaction.customId.replace(isUnban ? 'modlog_unban_' : 'modlog_removetimeout_', '');

    const modal = new ModalBuilder()
      .setCustomId(`modlog_reasonmodal_${isUnban ? 'unban' : 'removetimeout'}_${userId}`)
      .setTitle(isUnban ? 'Unban — Reason (optional)' : 'Remove Timeout — Reason (optional)');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)')
          .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
      ),
    );
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('modlog_reasonmodal_')) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '❌ Only staff can do this.', ephemeral: true });
    }

    const rest = interaction.customId.replace('modlog_reasonmodal_', '');
    const [actionType, userId] = rest.split('_');
    const isUnban = actionType === 'unban';
    const reason = interaction.fields.getTextInputValue('reason')?.trim() || 'No reason provided';
    const guild = await client.guilds.fetch(SERVER_ID);

    if (isUnban) {
      await guild.members.unban(userId, `Unbanned by ${interaction.user.username}: ${reason}`).catch(err => {
        console.error('❌ Unban failed:', err);
      });
    } else {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        await member.timeout(null, `Timeout removed by ${interaction.user.username}: ${reason}`).catch(err => {
          console.error('❌ Remove timeout failed:', err);
        });
      }
    }

    await interaction.reply({ content: `✅ ${isUnban ? 'Unbanned' : 'Timeout removed for'} <@${userId}>.`, ephemeral: true });

    // Track who removed it and why, in the same mod-log channel.
    try {
      const logChannel = await client.channels.fetch(MOD_LOG_CHANNEL_ID);
      const container = new ContainerBuilder()
        .setAccentColor(0x2ECC71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(isUnban ? '# 🔓 Unban Reversed' : '# ⏱️ Timeout Removed'))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `**User:** <@${userId}> (\`${userId}\`)\n\n**Removed By:** ${interaction.user} (\`${interaction.user.tag}\`)\n\n**Reason:** ${reason}\n\n-# <t:${Math.floor(Date.now() / 1000)}:F>`
        ));
      await logChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
      console.error('❌ Removal tracking log failed:', err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const isUploadCommand = !!COMMAND_CHANNEL_MAP[interaction.commandName];
  const isPartnersCommand = interaction.commandName === 'partners';
  const isGiveawayCommand = interaction.commandName === 'giveaway';
  const isGiveawayAnnounceCommand = interaction.commandName === 'giveawayannounce';
  const isAddBadServerCommand = interaction.commandName === 'addbadserver';
  const isRemoveBadServerCommand = interaction.commandName === 'removebadserver';
  const isListBadServersCommand = interaction.commandName === 'listbadservers';
  const isFixPermiCommand = interaction.commandName === 'fixpermi';
  const isDeleteRecentCommand = interaction.commandName === 'deleterecentmessages';
  const isServerInfoCommand = interaction.commandName === 'serverinfo';
  const isSayCommand = interaction.commandName === 'say';
  const isBackupCommand = interaction.commandName === 'backup';
  if (!isUploadCommand && !isPartnersCommand && !isGiveawayCommand && !isGiveawayAnnounceCommand
      && !isAddBadServerCommand && !isRemoveBadServerCommand && !isListBadServersCommand && !isFixPermiCommand
      && !isDeleteRecentCommand && !isServerInfoCommand && !isSayCommand && !isBackupCommand) return;

  try {
    // Role check FIRST, and reply immediately — no awaits before this so we
    // never hit the 3-second "application did not respond" timeout.
    if (!interaction.member?.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id))) {
      return interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
    }

    if (isPartnersCommand) {
      const text = interaction.options.getString('text');
      // Posts the text exactly as typed, as plain content (no embed box) — if
      // it contains a discord.gg invite link, Discord auto-renders the full
      // rich invite card (icon, member count, Join button) on its own.
      // @everyone is tagged automatically so the post actually pings.
      const partnersChannel = await client.channels.fetch(PARTNERS_CHANNEL_ID);
      await partnersChannel.send({
        content: `@everyone\n${text}`,
        allowedMentions: { parse: ['everyone'] },
      });
      return interaction.reply({ content: '✅ Posted!', ephemeral: true });
    }

    if (isGiveawayAnnounceCommand) {
      const text = interaction.options.getString('text');
      // Same idea as /partners — pastes the text exactly as typed, as plain
      // content, with @everyone tagged automatically.
      const announceChannel = await client.channels.fetch(GIVEAWAY_ANNOUNCE_CHANNEL_ID);
      await announceChannel.send({
        content: `@everyone\n${text}`,
        allowedMentions: { parse: ['everyone'] },
      });
      return interaction.reply({ content: '✅ Posted!', ephemeral: true });
    }

    if (isAddBadServerCommand) {
      const identifier = interaction.options.getString('identifier').toLowerCase().trim();
      const label = interaction.options.getString('label');
      acDB.badServers[identifier] = { label, addedBy: interaction.user.id, addedAt: Date.now() };
      saveAntiCheatDB();
      return interaction.reply({ content: `✅ Added **${label}** (\`${identifier}\`) to the watch list.`, ephemeral: true });
    }

    if (isRemoveBadServerCommand) {
      const identifier = interaction.options.getString('identifier').toLowerCase().trim();
      if (!acDB.badServers[identifier]) {
        return interaction.reply({ content: `⚠️ \`${identifier}\` isn't on the watch list.`, ephemeral: true });
      }
      const label = acDB.badServers[identifier].label;
      delete acDB.badServers[identifier];
      saveAntiCheatDB();
      return interaction.reply({ content: `✅ Removed **${label}** (\`${identifier}\`) from the watch list.`, ephemeral: true });
    }

    if (isListBadServersCommand) {
      const entries = Object.entries(acDB.badServers);
      const list = entries.length
        ? entries.map(([id, info]) => `• **${info.label}** — \`${id}\``).join('\n')
        : 'The watch list is empty.';
      return interaction.reply({ content: `🚫 **Anti-Cheat Watch List**\n\n${list}`, ephemeral: true });
    }

    if (isFixPermiCommand) {
      await interaction.deferReply({ ephemeral: true });

      const guild = await client.guilds.fetch(SERVER_ID);
      const botMember = await guild.members.fetchMe();
      const channels = await guild.channels.fetch();

      const fixed = [];
      const alreadyOk = [];
      const failed = [];

      for (const [, channel] of channels) {
        if (!channel || channel.type === ChannelType.GuildCategory) continue;
        // Only channels that can carry text (regular text, announcement,
        // voice with text-in-voice, forum, stage) are relevant here.
        if (typeof channel.permissionsFor !== 'function' || typeof channel.permissionOverwrites?.edit !== 'function') continue;

        try {
          const perms = channel.permissionsFor(botMember);
          const missing = Object.keys(REQUIRED_CHANNEL_PERMS).filter(p => !perms?.has(p));
          if (missing.length === 0) {
            alreadyOk.push(channel.name);
            continue;
          }
          await channel.permissionOverwrites.edit(botMember.id, REQUIRED_CHANNEL_PERMS, { reason: `/fixpermi run by ${interaction.user.username}` });
          fixed.push(`#${channel.name} (${missing.join(', ')})`);
        } catch (err) {
          console.error(`❌ /fixpermi failed for #${channel.name}:`, err.message);
          failed.push(channel.name);
        }
      }

      let summary =
        `✅ **Scan complete** — ${channels.size} channels checked.\n\n` +
        `🔧 **Fixed (${fixed.length}):** ${fixed.length ? fixed.join(', ') : 'None needed fixing'}\n\n` +
        `☑️ **Already OK:** ${alreadyOk.length} channels`;
      if (failed.length) {
        summary += `\n\n❌ **Failed (${failed.length}):** ${failed.join(', ')} — check the bot's role position and that it has Manage Roles / Administrator.`;
      }
      if (summary.length > 1900) summary = summary.slice(0, 1900) + '\n… (truncated)';

      return interaction.editReply({ content: summary });
    }

    if (isDeleteRecentCommand) {
      await interaction.deferReply({ ephemeral: true });

      const targetUser = interaction.options.getUser('user');
      const minutes = interaction.options.getInteger('minutes');
      const cutoff = Date.now() - minutes * 60 * 1000;

      const guild = await client.guilds.fetch(SERVER_ID);
      const channels = await guild.channels.fetch();

      let totalDeleted = 0;
      const perChannel = [];
      const failed = [];

      for (const [, channel] of channels) {
        if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) continue;
        if (channel.type === ChannelType.GuildCategory) continue;

        try {
          const toDelete = [];
          let beforeId;

          // Page backward through history until we pass the time cutoff or
          // run out of messages in this channel.
          while (true) {
            const batch = await channel.messages.fetch({ limit: 100, ...(beforeId ? { before: beforeId } : {}) });
            if (batch.size === 0) break;

            let hitCutoff = false;
            for (const msg of batch.values()) {
              if (msg.createdTimestamp < cutoff) { hitCutoff = true; continue; }
              if (msg.author.id === targetUser.id) toDelete.push(msg.id);
            }

            beforeId = batch.last().id;
            if (hitCutoff || batch.size < 100) break;
          }

          if (toDelete.length === 0) continue;

          // bulkDelete only accepts up to 100 IDs per call and silently
          // skips anything older than 14 days when the second arg is true.
          let deletedHere = 0;
          for (let i = 0; i < toDelete.length; i += 100) {
            const chunk = toDelete.slice(i, i + 100);
            const result = await channel.bulkDelete(chunk, true).catch(err => {
              console.error(`❌ Bulk delete failed in #${channel.name}:`, err.message);
              return null;
            });
            if (result) deletedHere += result.size;
          }

          if (deletedHere > 0) {
            totalDeleted += deletedHere;
            perChannel.push(`#${channel.name} (${deletedHere})`);
          }
        } catch (err) {
          console.error(`❌ /deleterecentmessages failed for #${channel.name}:`, err.message);
          failed.push(channel.name);
        }
      }

      let summary =
        `✅ **Done.** Deleted **${totalDeleted}** message${totalDeleted === 1 ? '' : 's'} from ${targetUser} in the last ${minutes} minute${minutes === 1 ? '' : 's'}.\n\n` +
        (perChannel.length ? `**Channels:** ${perChannel.join(', ')}` : '_No matching messages found._');
      if (failed.length) summary += `\n\n❌ **Couldn't check:** ${failed.join(', ')} (missing permissions?)`;
      if (summary.length > 1900) summary = summary.slice(0, 1900) + '\n… (truncated)';

      return interaction.editReply({ content: summary });
    }

    if (isServerInfoCommand) {
      await interaction.channel.send({
        components: [buildServerInfoContainer()],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
      return interaction.reply({ content: '✅ Server-Info panel posted!', ephemeral: true });
    }

    if (isSayCommand) {
      const text = interaction.options.getString('text');
      await interaction.channel.send({ content: text, allowedMentions: { parse: [] } });
      return interaction.reply({ content: '✅ Posted in this channel!', ephemeral: true });
    }

    // ✅ BACKUP COMMAND — sends anticheat.json as a Discord attachment
    if (isBackupCommand) {
      await interaction.deferReply({ ephemeral: true });
      if (!fs.existsSync(DATA_FILE)) {
        return interaction.editReply({ content: '❌ No backup file found! (`anticheat.json` does not exist yet)' });
      }
      const attachment = new AttachmentBuilder(DATA_FILE, { name: 'anticheat.json' });
      await interaction.editReply({
        content: `✅ Here is your backup file! Download it and keep it safe.\n\n**To restore on a new Railway account:**\n1. Deploy the bot on new Railway\n2. Add a Volume at \`/data\`\n3. Go to Console tab and run:\n\`\`\`\ncat > /data/anticheat.json < /dev/stdin\n\`\`\`\nthen paste the file contents`,
        files: [attachment],
      });
      return;
    }

    if (isGiveawayCommand) {
      const prize = interaction.options.getString('prize');
      const minutes = interaction.options.getInteger('minutes');
      const winnersCount = interaction.options.getInteger('winners') || 1;

      const giveawayChannel = await client.channels.fetch(GIVEAWAY_CHANNEL_ID);
      const giveawayId = `ga_${Date.now()}_${interaction.user.id}`;
      const endsAt = Date.now() + minutes * 60 * 1000;

      const giveaway = {
        prize, endsAt, winnersCount,
        participants: new Set(),
        channelId: GIVEAWAY_CHANNEL_ID,
        messageId: null,
        ended: false,
        hostId: interaction.user.id,
        winners: [],
      };

      const sent = await giveawayChannel.send({
        components: [buildGiveawayContainer(giveaway), buildGiveawayButtonRow(giveawayId, false)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: ['everyone'] },
      });
      giveaway.messageId = sent.id;
      giveaways.set(giveawayId, giveaway);
      persistGiveaway(giveawayId);
      scheduleGiveawayEnd(giveawayId, endsAt - Date.now());

      return interaction.reply({ content: `✅ Giveaway started in <#${GIVEAWAY_CHANNEL_ID}>!`, ephemeral: true });
    }

    const name = interaction.options.getString('name');
    const filepath = interaction.options.getString('filepath');
    const link = interaction.options.getString('link');
    const password = interaction.options.getString('password');
    const preview = interaction.options.getString('preview');

    const screenshots = [1, 2, 3, 4, 5]
      .map(i => interaction.options.getAttachment(`screenshot${i}`))
      .filter(Boolean);

    const targetChannelId = COMMAND_CHANNEL_MAP[interaction.commandName];
    const targetChannel = await client.channels.fetch(targetChannelId);

    const payload = { content: buildUploadContent({ name, link, password, preview, filepath }) };
    // Re-attach every uploaded screenshot so each renders as its own image
    // card, in addition to (or instead of) the auto-embedded video-link preview.
    if (screenshots.length) {
      payload.files = screenshots.map(s => ({ attachment: s.url, name: s.name }));
    }

    await targetChannel.send(payload);
    return interaction.reply({ content: `✅ Posted in <#${targetChannelId}>!`, ephemeral: true });
  } catch (err) {
    console.error('❌ Command failed:', err);
    const payload = { content: '❌ Something went wrong — check the bot\'s permissions in that channel.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
 } catch (outerErr) {
  // Final safety net — nothing thrown inside this handler (including the
  // giveaway button branches above) should ever be able to crash the
  // process. Node 18+ terminates the whole app on an unhandled rejection,
  // which is what was crashing the bot and interrupting welcome messages.
  console.error('❌ Interaction handler error:', outerErr);
 }
});

// =========================================
// ✅ KEEP-ALIVE HTTP SERVER (Railway)
// =========================================
http.createServer((req, res) => { res.writeHead(200); res.end('Bot is running'); })
  .listen(process.env.PORT || 3000);

// =========================================
// ✅ GLOBAL SAFETY NET — never let one bad error kill the whole bot
// =========================================
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});

client.login(process.env.TOKEN);
