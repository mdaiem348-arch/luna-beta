require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const express = require('express');

const db = new Database('beta.db');
const COOLDOWN_MS = 1 * 24 * 60 * 60 * 1000;

db.exec(`CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, used INTEGER DEFAULT 0, used_by TEXT, used_at INTEGER, created_by TEXT);
CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password TEXT, hwid TEXT, discord_id TEXT, banned INTEGER DEFAULT 0, used_key TEXT, launch_count INTEGER DEFAULT 0, hwid_reset_count INTEGER DEFAULT 0, last_hwid_reset INTEGER, role_given INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS whitelist (discord_id TEXT PRIMARY KEY, role TEXT);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS key_blacklist (key TEXT PRIMARY KEY, reason TEXT, blacklisted_by TEXT, blacklisted_at INTEGER);`);

function generateKey() { const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let k=''; for(let i=0;i<32;i++) k+=c[Math.floor(Math.random()*c.length)]; return k; }
function hasPerm(id, role){ const r=db.prepare('SELECT role FROM whitelist WHERE discord_id=?').get(id); return r?.role==='owner'||(role==='mod'&&r?.role==='mod'); }
function canReset(acc){ return !acc.last_hwid_reset||(Date.now()-acc.last_hwid_reset)>=COOLDOWN_MS; }
function getConfig(k){ return db.prepare('SELECT value FROM config WHERE key=?').get(k)?.value; }
function setConfig(k,v){ db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)').run(k,v); }
function isKeyBlacklisted(key){ return db.prepare('SELECT 1 FROM key_blacklist WHERE key=?').get(key); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages] });

client.once('ready', async () => {
    console.log('✅ Beta Bot Online');
    await client.user.setUsername('Luna-Beta');
    client.user.setActivity('/panel | $24.99 Beta', { type: 'WATCHING' });
    console.log('Beta bot is ready!');
    
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: [
        new SlashCommandBuilder().setName('ping').setDescription('Test the bot'),
        new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
        new SlashCommandBuilder().setName('setup').setDescription('Setup the bot').addRoleOption(o=>o.setName('role').setDescription('The role to give to beta users').setRequired(true)),
        new SlashCommandBuilder().setName('gen').setDescription('Generate beta keys').addIntegerOption(o=>o.setName('amount').setDescription('Number of keys to generate').setRequired(true)).addUserOption(o=>o.setName('user').setDescription('User to send keys to').setRequired(true)),
        new SlashCommandBuilder().setName('createaccount').setDescription('Create a beta account').addStringOption(o=>o.setName('key').setDescription('Your beta license key').setRequired(true)).addStringOption(o=>o.setName('username').setDescription('Desired username').setRequired(true)).addStringOption(o=>o.setName('password').setDescription('Desired password').setRequired(true)),
        new SlashCommandBuilder().setName('stats').setDescription('View bot statistics'),
        new SlashCommandBuilder().setName('panel').setDescription('Open control panel'),
        new SlashCommandBuilder().setName('whitelist').setDescription('Whitelist a user').addUserOption(o=>o.setName('user').setDescription('User to whitelist').setRequired(true)),
        new SlashCommandBuilder().setName('blacklist').setDescription('Blacklist a user').addUserOption(o=>o.setName('user').setDescription('User to blacklist').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason for blacklist')),
        new SlashCommandBuilder().setName('blacklistkey').setDescription('Blacklist a license key').addStringOption(o=>o.setName('key').setDescription('Key to blacklist').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason for blacklist')),
        new SlashCommandBuilder().setName('unblacklistkey').setDescription('Remove key from blacklist').addStringOption(o=>o.setName('key').setDescription('Key to unblacklist').setRequired(true)),
        new SlashCommandBuilder().setName('forcereset').setDescription('Force HWID reset (bypass cooldown)').addUserOption(o=>o.setName('user').setDescription('User to reset').setRequired(true)),
        new SlashCommandBuilder().setName('userinfo').setDescription('Get user information').addStringOption(o=>o.setName('username').setDescription('Username or Discord ID').setRequired(true)),
        new SlashCommandBuilder().setName('addmod').setDescription('Add a moderator').addUserOption(o=>o.setName('user').setDescription('User to promote').setRequired(true)),
        new SlashCommandBuilder().setName('removemod').setDescription('Remove a moderator').addUserOption(o=>o.setName('user').setDescription('User to demote').setRequired(true))
    ] });
    console.log('Beta commands registered');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    
    const { commandName, options, user, guild } = interaction;
    
    if (commandName === 'ping') {
        await interaction.reply({ content: '🏓 Pong! Beta bot is working!', ephemeral: true });
        return;
    }
    
    if (commandName === 'help') {
        const embed = new EmbedBuilder().setTitle('⚡ Luna Beta Commands').setColor(0xffaa00)
            .addFields(
                { name: 'General', value: '`/ping` `/help` `/stats` `/panel`', inline: true },
                { name: 'Account', value: '`/createaccount` `/userinfo`', inline: true },
                { name: 'Moderation', value: '`/whitelist` `/blacklist` `/blacklistkey` `/unblacklistkey` `/forcereset` `/gen`', inline: true },
                { name: 'Admin', value: '`/setup` `/addmod` `/removemod`', inline: true },
                { name: 'Beta Benefit', value: '⚡ **1-day HWID cooldown** (instead of 3 days)', inline: false }
            );
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }
    
    if (commandName === 'setup') {
        if (!hasPerm(user.id, 'owner')) {
            await interaction.reply({ content: '❌ Owner only', ephemeral: true });
            return;
        }
        const role = options.getRole('role');
        setConfig('guild_id', guild.id);
        setConfig('role_id', role.id);
        await interaction.reply({ content: '✅ Beta bot setup complete!', ephemeral: true });
        return;
    }
    
    if (commandName === 'gen') {
        if (!hasPerm(user.id, 'mod')) {
            await interaction.reply({ content: '❌ Mods only', ephemeral: true });
            return;
        }
        const amount = options.getInteger('amount');
        const target = options.getUser('user');
        const keys = [];
        for (let i = 0; i < amount; i++) {
            const k = generateKey();
            db.prepare('INSERT INTO keys(key, created_by) VALUES(?,?)').run(k, user.id);
            keys.push(k);
        }
        await target.send(`⚡ **Beta License Keys**\n\`\`\`\n${keys.join('\n')}\n\`\`\``);
        await interaction.reply({ content: `✅ Generated ${amount} beta key(s) and sent to ${target.tag}`, ephemeral: true });
        return;
    }
    
    if (commandName === 'createaccount') {
        const key = options.getString('key');
        const username = options.getString('username');
        const password = options.getString('password');
        
        if (isKeyBlacklisted(key)) {
            await interaction.reply({ content: '❌ This key has been blacklisted.', ephemeral: true });
            return;
        }
        const keyRow = db.prepare('SELECT * FROM keys WHERE key=? AND used=0').get(key);
        if (!keyRow) {
            await interaction.reply({ content: '❌ Invalid or used key', ephemeral: true });
            return;
        }
        if (db.prepare('SELECT * FROM accounts WHERE username=?').get(username)) {
            await interaction.reply({ content: '❌ Username already taken', ephemeral: true });
            return;
        }
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('INSERT INTO accounts(username,password,discord_id,used_key) VALUES(?,?,?,?)').run(username, hash, user.id, key);
        db.prepare('UPDATE keys SET used=1, used_by=?, used_at=? WHERE key=?').run(user.id, Date.now(), key);
        await interaction.reply({ content: `✅ Beta account **${username}** created! Use /panel to manage.`, ephemeral: true });
        return;
    }
    
    if (commandName === 'stats') {
        const total = db.prepare('SELECT COUNT(*) c FROM keys').get().c;
        const used = db.prepare('SELECT COUNT(*) c FROM keys WHERE used=1').get().c;
        const usersCount = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
        const banned = db.prepare('SELECT COUNT(*) c FROM accounts WHERE banned=1').get().c;
        const blacklistedKeys = db.prepare('SELECT COUNT(*) c FROM key_blacklist').get().c;
        await interaction.reply({ content: `⚡ **Beta Statistics**\nTotal Keys: ${total}\nUsed Keys: ${used}\nUsers: ${usersCount}\nBanned: ${banned}\nBlacklisted Keys: ${blacklistedKeys}\nAvailable: ${total-used}`, ephemeral: true });
        return;
    }
    
    if (commandName === 'panel') {
        await interaction.reply({ content: '⚡ **Beta Panel**\nUse `/createaccount` to activate a beta key.\nUse `/stats` for bot info.\n⚡ HWID cooldown: **1 day**', ephemeral: true });
        return;
    }
    
    if (commandName === 'whitelist') {
        if (!hasPerm(user.id, 'mod')) {
            await interaction.reply({ content: '❌ Mods only', ephemeral: true });
            return;
        }
        const target = options.getUser('user');
        const key = generateKey();
        db.prepare('INSERT INTO keys(key, created_by) VALUES(?,?)').run(key, user.id);
        await target.send(`⚡ **Beta Whitelist**\nLicense key: \`${key}\`\nUse \`/createaccount ${key} YOUR_USERNAME YOUR_PASSWORD\` to activate.\n⚡ 1-day HWID cooldown`);
        await interaction.reply({ content: `✅ Whitelisted ${target.tag} with beta key.`, ephemeral: true });
        return;
    }
    
    if (commandName === 'blacklist') {
        if (!hasPerm(user.id, 'mod')) {
            await interaction.reply({ content: '❌ Mods only', ephemeral: true });
            return;
        }
        const target = options.getUser('user');
        const reason = options.getString('reason') || 'No reason';
        const account = db.prepare('SELECT * FROM accounts WHERE discord_id=?').get(target.id);
        if (account) {
            db.prepare('UPDATE accounts SET banned=1 WHERE discord_id=?').run(target.id);
            await target.send(`❌ **Beta Blacklist**\nReason: ${reason}`);
            await interaction.reply({ content: `✅ Blacklisted ${target.tag}\nReason: ${reason}`, ephemeral: true });
        } else {
            await interaction.reply({ content: `❌ ${target.tag} has no account.`, ephemeral: true });
        }
        return;
    }
    
    if (commandName === 'blacklistkey') {
        if (!hasPerm(user.id, 'mod')) {
            await interaction.reply({ content: '❌ Mods only', ephemeral: true });
            return;
        }
        const key = options.getString('key');
        const reason = options.getString('reason') || 'No reason';
        const keyExists = db.prepare('SELECT * FROM keys WHERE key=?').get(key);
        if (!keyExists) {
            await interaction.reply({ content: '❌ Key not found.', ephemeral: true });
            return;
        }
        db.prepare('INSERT INTO key_blacklist(key, reason, blacklisted_by, blacklisted_at) VALUES(?,?,?,?)').run(key, reason, user.id, Date.now());
        const account = db.prepare('SELECT * FROM accounts WHERE used_key=?').get(key);
        if (account) {
            db.prepare('UPDATE accounts SET banned=1 WHERE username=?').run(account.username);
            const discordUser = await client.users.fetch(account.discord_id);
            if (discordUser) await discordUser.send(`❌ Your beta key has been blacklisted.\nReason: ${reason}`);
        }
        await interaction.reply({ content: `✅ Beta key \`${key}\` blacklisted.`, ephemeral: true });
        return;
    }
    
    if (commandName === 'unblacklistkey') {
        if (!hasPerm(user.id, 'mod')) {
            await interaction.reply({ content: '❌ Mods only', ephemeral: true });
            return;
        }
        const key = options.getString('key');
        const blacklisted = db.prepare('SELECT * FROM key_blacklist WHERE key=?').get(key);
        if (!blacklisted) {
            await interaction.reply({ content: '❌ Key not blacklisted.', ephemeral: true });
            return;
        }
        db.prepare('DELETE FROM key_blacklist WHERE key=?').run(key);
        await interaction.reply({ content: `✅ Beta key \`${key}\` removed from blacklist.`, ephemeral: true });
        return;
    }
    
    if (commandName === 'forcereset') {
        if (!hasPerm(user.id, 'mod')) {
            await interaction.reply({ content: '❌ Mods only', ephemeral: true });
            return;
        }
        const target = options.getUser('user');
        const account = db.prepare('SELECT * FROM accounts WHERE discord_id=?').get(target.id);
        if (!account) {
            await interaction.reply({ content: `❌ ${target.tag} has no account.`, ephemeral: true });
            return;
        }
        db.prepare('UPDATE accounts SET hwid=NULL, last_hwid_reset=NULL WHERE discord_id=?').run(target.id);
        await target.send(`🔄 **Beta HWID Reset**\nA moderator reset your HWID. (1-day cooldown waived)`);
        await interaction.reply({ content: `✅ Force reset for ${target.tag}`, ephemeral: true });
        return;
    }
    
    if (commandName === 'userinfo') {
        if (!hasPerm(user.id, 'mod')) {
            await interaction.reply({ content: '❌ Mods only', ephemeral: true });
            return;
        }
        const identifier = options.getString('username');
        const account = db.prepare('SELECT * FROM accounts WHERE username=? OR discord_id=?').get(identifier, identifier);
        if (!account) {
            await interaction.reply({ content: `❌ User ${identifier} not found.`, ephemeral: true });
            return;
        }
        const remaining = account.last_hwid_reset ? COOLDOWN_MS - (Date.now() - account.last_hwid_reset) : 0;
        const hours = Math.ceil(remaining / (60 * 60 * 1000));
        const embed = new EmbedBuilder().setTitle('⚡ Beta User Info').setColor(0xffaa00)
            .addFields(
                { name: 'Username', value: account.username, inline: true },
                { name: 'Discord', value: `<@${account.discord_id}>`, inline: true },
                { name: 'Banned', value: account.banned ? 'Yes' : 'No', inline: true },
                { name: 'HWID', value: account.hwid || 'Not bound', inline: true },
                { name: 'Launches', value: String(account.launch_count), inline: true },
                { name: 'Resets', value: String(account.hwid_reset_count), inline: true },
                { name: 'Cooldown (1d)', value: remaining > 0 ? `${hours} hours left` : 'Ready', inline: true },
                { name: 'Key', value: `||${account.used_key}||`, inline: false }
            );
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }
    
    if (commandName === 'addmod') {
        if (!hasPerm(user.id, 'owner')) {
            await interaction.reply({ content: '❌ Owner only', ephemeral: true });
            return;
        }
        const target = options.getUser('user');
        db.prepare('INSERT OR REPLACE INTO whitelist(discord_id, role) VALUES(?,?)').run(target.id, 'mod');
        await target.send(`👮 You've been promoted to **Beta Moderator**.`);
        await interaction.reply({ content: `✅ Added ${target.tag} as beta moderator.`, ephemeral: true });
        return;
    }
    
    if (commandName === 'removemod') {
        if (!hasPerm(user.id, 'owner')) {
            await interaction.reply({ content: '❌ Owner only', ephemeral: true });
            return;
        }
        const target = options.getUser('user');
        db.prepare('DELETE FROM whitelist WHERE discord_id=? AND role=?').run(target.id, 'mod');
        await target.send(`👮 You've been removed as **Beta Moderator**.`);
        await interaction.reply({ content: `✅ Removed ${target.tag} as beta moderator.`, ephemeral: true });
        return;
    }
    
    await interaction.reply({ content: `Command \`${commandName}\` is not yet implemented.`, ephemeral: true });
});

const app = express();
app.use(express.json());

app.post('/login', (req, res) => {
    const { username, password, hwid } = req.body;
    const acc = db.prepare('SELECT * FROM accounts WHERE username=? COLLATE NOCASE').get(username);
    if (!acc) return res.json({ success: false, reason: 'Invalid credentials' });
    if (acc.banned) return res.json({ success: false, reason: 'Account banned' });
    if (isKeyBlacklisted(acc.used_key)) return res.json({ success: false, reason: 'License key blacklisted' });
    if (!bcrypt.compareSync(password, acc.password)) return res.json({ success: false, reason: 'Invalid credentials' });
    if (!acc.hwid) { db.prepare('UPDATE accounts SET hwid=?, launch_count=launch_count+1 WHERE username=?').run(hwid, username); return res.json({ success: true, reason: 'HWID bound' }); }
    if (acc.hwid !== hwid) return res.json({ success: false, reason: 'HWID mismatch' });
    db.prepare('UPDATE accounts SET launch_count=launch_count+1 WHERE username=?').run(username);
    res.json({ success: true, reason: 'Login successful' });
});

// ✅ Health check endpoint for cron-job.org (keeps bot awake 24/7)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(3002, () => console.log('⚡ Beta API on 3002'));

client.login(process.env.DISCORD_TOKEN);
