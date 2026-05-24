import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const jsonFile = message.attachments.find((a) =>
    a.name?.toLowerCase().endsWith(".json")
  );
  if (!jsonFile) return;

  try {
    const res  = await fetch(jsonFile.url);
    const text = await res.text();
    const meta = parseMacro(text);

    if (meta === null) {
      await message.reply(
        "Macro is invalid/corrupted — copying to clipboard is not recommended."
      );
      return;
    }

    // Parse expiry from Discord's CDN URL params
    const expiry = getExpiry(jsonFile.url);

    const embed = buildEmbed(jsonFile.url, jsonFile.name, meta, expiry);
    await message.reply({ embeds: [embed] });

    await pinThreadStarter(message.channel);
  } catch (err) {
    console.error("Error handling macro upload:", err);
    await message
      .reply("⚠️ Something went wrong processing that file.")
      .catch(() => {});
  }
});

// ── Pin the thread's first message ───────────────────────────────────────────

async function pinThreadStarter(thread) {
  try {
    const starter = await thread.fetchStarterMessage();
    if (!starter) return;
    const pins = await thread.messages.fetchPinned();
    if (pins.has(starter.id)) return;
    await starter.pin();
  } catch (err) {
    console.warn("Could not pin starter message:", err.message);
  }
}

// ── Parse & validate macro JSON ───────────────────────────────────────────────
// A valid macro must be a non-empty array where at least one entry has a "Type" field.

function parseMacro(jsonText) {
  try {
    const data = JSON.parse(jsonText);

    // Must be a non-empty array
    if (!Array.isArray(data) || data.length === 0) return null;

    // At least one action must have a "Type" field (macro signature)
    const hasType = data.some(
      (action) => action && typeof action.Type === "string"
    );
    if (!hasType) return null;

    const totalSteps = data.length;

    const unitSet = new Set();
    for (const action of data) {
      if (action.Type === "spawn_unit" && action.Unit) {
        unitSet.add(action.Unit.replace(/ #\d+$/, ""));
      }
    }

    const units = unitSet.size > 0 ? [...unitSet].join(", ") : "None";

    return { totalSteps, units };
  } catch {
    return null;
  }
}

// ── Extract expiry date from Discord CDN URL ──────────────────────────────────
// The "ex" param is a Unix hex timestamp of when the URL expires.

function getExpiry(url) {
  try {
    const ex = new URL(url).searchParams.get("ex");
    if (!ex) return null;
    const ts = parseInt(ex, 16) * 1000;
    return new Date(ts);
  } catch {
    return null;
  }
}

// ── Build embed ───────────────────────────────────────────────────────────────

function buildEmbed(url, filename, meta, expiry) {
  const expiryText = expiry
    ? `⚠️ Link expires <t:${Math.floor(expiry.getTime() / 1000)}:R>`
    : "⚠️ Link may expire — re-upload to refresh it";

  return new EmbedBuilder()
    .setTitle(filename.replace(/\.json$/i, ""))
    .setURL(url)
    .setColor(0x5865f2)
    .addFields(
      { name: "Steps",  value: String(meta.totalSteps), inline: true },
      { name: "Units",  value: meta.units,              inline: true }
    )
    .setFooter({ text: expiryText });
}

// ── Start ─────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
