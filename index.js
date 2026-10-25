
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require("discord.js");

const Database = require("better-sqlite3");
const crypto = require("crypto");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  throw new Error("Set DISCORD_TOKEN and CLIENT_ID in hosting environment.");
}

const db = new Database("chilly.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY,
 coins INTEGER DEFAULT 0,
 daily INTEGER DEFAULT 0,
 work INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS giveaways (
 id TEXT PRIMARY KEY,
 guild TEXT,
 channel TEXT,
 message TEXT,
 prize TEXT,
 winners INTEGER,
 host TEXT,
 ends INTEGER,
 ended INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entries (
 giveaway TEXT,
 user TEXT,
 PRIMARY KEY (giveaway, user)
);
`);

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Check Chilly latency"),
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),

  new SlashCommandBuilder().setName("balance").setDescription("Check coin balance")
    .addUserOption(o => o.setName("user").setDescription("Member")),

  new SlashCommandBuilder().setName("daily").setDescription("Claim daily coins"),
  new SlashCommandBuilder().setName("work").setDescription("Earn virtual coins"),

  new SlashCommandBuilder().setName("give").setDescription("Give coins to a member")
    .addUserOption(o => o.setName("user").setDescription("Recipient").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Coins")
      .setMinValue(1).setRequired(true)),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Top coin holders"),

  new SlashCommandBuilder().setName("giveaway").setDescription("Create a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName("prize").setDescription("Prize").setRequired(true))
    .addIntegerOption(o => o.setName("winners").setDescription("Winner count")
      .setMinValue(1).setMaxValue(20).setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("10m, 2h, 1d")
      .setRequired(true)),

  new SlashCommandBuilder().setName("giveaway-end").setDescription("End a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName("id").setDescription("Giveaway ID").setRequired(true)),

  new SlashCommandBuilder().setName("ban").setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)),

  new SlashCommandBuilder().setName("kick").setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: "10" }).setToken(TOKEN);

function user(id) {
  db.prepare("INSERT OR IGNORE INTO users (id) VALUES (?)").run(id);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function addCoins(id, amount) {
  user(id);
  db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(amount, id);
}

function duration(s) {
  const m = s.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return 0;
  return Number(m[1]) * ({s:1000,m:60000,h:3600000,d:86400000})[m[2].toLowerCase()];
}

function embed(g, ended = false, winners = []) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE giveaway = ?")
    .get(g.id).n;

  return new EmbedBuilder()
    .setColor(0x36c5f0)
    .setTitle("🎉 Chilly Giveaway 🎉")
    .setDescription(
      `🎁 **Prize:** ${g.prize}\n` +
      `🏆 **Winners:** ${g.winners}\n` +
      `👤 **Host:** <@${g.host}>\n` +
      `👥 **Entries:** ${count}\n` +
      (ended ? `\n**Ended!**\n${winners.length ? winners.map(x => `<@${x}>`).join(", ") : "No entries"}` :
      `⏰ **Ends:** <t:${Math.floor(g.ends / 1000)}:R>\n\nPress 🎉 to enter!`)
    )
    .setFooter({ text: `Chilly • Giveaway ID: ${g.id}` });
}

async function finish(id) {
  const g = db.prepare("SELECT * FROM giveaways WHERE id = ?").get(id);
  if (!g || g.ended) return false;

  db.prepare("UPDATE giveaways SET ended = 1 WHERE id = ?").run(id);

  const entries = db.prepare("SELECT user FROM entries WHERE giveaway = ?")
    .all(id).map(x => x.user);

  for (let i = entries.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }

  const winners = entries.slice(0, g.winners);
  const channel = await client.channels.fetch(g.channel).catch(() => null);

  if (channel) {
    const msg = await channel.messages.fetch(g.message).catch(() => null);
    if (msg) await msg.edit({ embeds: [embed(g, true, winners)], components: [] }).catch(console.error);
    if (winners.length) await channel.send(`🎉 **${g.prize}** winner(s): ${winners.map(x => `<@${x}>`).join(", ")}`);
    else await channel.send(`Giveaway **${g.prize}** ended without entries.`);
  }
  return winners;
}

client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isButton() && i.customId.startsWith("gw:")) {
      const id = i.customId.slice(3);
      const g = db.prepare("SELECT * FROM giveaways WHERE id = ?").get(id);

      if (!g || g.ended || g.ends <= Date.now())
        return i.reply({ content: "This giveaway has ended.", ephemeral: true });

      const old = db.prepare("SELECT 1 FROM entries WHERE giveaway = ? AND user = ?")
        .get(id, i.user.id);

      if (old) {
        db.prepare("DELETE FROM entries WHERE giveaway = ? AND user = ?").run(id, i.user.id);
        return i.reply({ content: "Entry removed.", ephemeral: true });
      }

      db.prepare("INSERT INTO entries (giveaway, user) VALUES (?, ?)").run(id, i.user.id);
      return i.reply({ content: "🎉 You're entered!", ephemeral: true });
    }

    if (!i.isChatInputCommand()) return;
    const name = i.commandName;
    const uid = i.user.id;

    if (name === "ping") return i.reply(`🏓 Pong! ${client.ws.ping}ms`);

    if (name === "help") return i.reply({
      content: "**Chilly Commands**\n`/ping` `/help` `/balance` `/daily` `/work` `/give` `/leaderboard` `/giveaway` `/giveaway-end` `/ban` `/kick`",
      ephemeral: true
    });

    if (name === "balance") {
      const target = i.options.getUser("user") || i.user;
      return i.reply(`💰 **${target.username}** has **${user(target.id).coins} Chilly Coins**.`);
    }

    if (name === "daily" || name === "work") {
      const u = user(uid);
      const field = name === "daily" ? "daily" : "work";
      const wait = name === "daily" ? 86400000 : 3600000;

      if (Date.now() - u[field] < wait)
        return i.reply({ content: "⏳ You're on cooldown. Try again later.", ephemeral: true });

      const coins = name === "daily" ? 500 : crypto.randomInt(100, 251);
      db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(Date.now(), uid);
      addCoins(uid, coins);
      return i.reply(`🧊 You earned **${coins} Chilly Coins**! Balance: **${user(uid).coins}**`);
    }

    if (name === "give") {
      const target = i.options.getUser("user");
      const amount = i.options.getInteger("amount");

      if (target.bot || target.id === uid || user(uid).coins < amount)
        return i.reply({ content: "Invalid recipient or insufficient coins.", ephemeral: true });

      addCoins(uid, -amount);
      addCoins(target.id, amount);
      return i.reply(`💸 Sent **${amount} coins** to ${target}.`);
    }

    if (name === "leaderboard") {
      const top = db.prepare("SELECT id, coins FROM users ORDER BY coins DESC LIMIT 10").all();
      return i.reply(top.length
        ? "**🧊 Chilly Coin Leaderboard**\n" + top.map((x,n) => `${n+1}. <@${x.id}> — ${x.coins} coins`).join("\n")
        : "No economy users yet.");
    }

    if (name === "giveaway") {
      const prize = i.options.getString("prize");
      const winners = i.options.getInteger("winners");
      const ms = duration(i.options.getString("duration"));

      if (!ms || ms < 10000 || ms > 30 * 86400000)
        return i.reply({ content: "Use a duration from 10s to 30d, e.g. 10m or 2h.", ephemeral: true });

      await i.deferReply({ ephemeral: true });

      const id = crypto.randomUUID().slice(0,8);
      const g = { id, guild: i.guildId, channel: i.channelId, prize, winners, host: uid, ends: Date.now()+ms, message: "" };
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw:${id}`).setLabel("🎉 Enter Giveaway").setStyle(ButtonStyle.Primary)
      );

      const msg = await i.channel.send({ embeds: [embed(g)], components: [row] });
      g.message = msg.id;

      db.prepare("INSERT INTO giveaways (id,guild,channel,message,prize,winners,host,ends) VALUES (?,?,?,?,?,?,?,?)")
        .run(g.id,g.guild,g.channel,g.message,g.prize,g.winners,g.host,g.ends);

      return i.editReply(`✅ Giveaway created! ID: \`${id}\``);
    }

    if (name === "giveaway-end") {
      const result = await finish(i.options.getString("id"));
      return i.reply({ content: result === false ? "Giveaway not found or already ended." : "✅ Giveaway ended.", ephemeral: true });
    }

    if (name === "ban" || name === "kick") {
      const target = i.options.getUser("user");
      const member = await i.guild.members.fetch(target.id).catch(() => null);

      if (!member || !member.manageable || target.id === uid)
        return i.reply({ content: "Cannot moderate this member.", ephemeral: true });

      if (name === "ban") {
        if (!member.bannable) return i.reply({ content: "I cannot ban this member.", ephemeral: true });
        await member.ban({ reason: `Action by ${i.user.tag}` });
      } else await member.kick(`Action by ${i.user.tag}`);

      return i.reply(`✅ ${target.tag} ${name === "ban" ? "banned" : "kicked"}.`);
    }
  } catch (e) {
    console.error(e);
    if (i.isRepliable()) {
      const msg = { content: "An error occurred. Check bot permissions and logs.", ephemeral: true };
      if (i.replied || i.deferred) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
  }
});

client.once(Events.ClientReady, c => {
  console.log(`🧊 Chilly is online as ${c.user.tag}`);
});

async function main() {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  await client.login(TOKEN);
}

main().catch(console.error);

setInterval(async () => {
  const rows = db.prepare("SELECT id FROM giveaways WHERE ended = 0 AND ends <= ?").all(Date.now());
  for (const g of rows) await finish(g.id).catch(console.error);
}, 15000);
                             
