import { Client, GatewayIntentBits } from "discord.js";

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

    const expiry  = getExpiry(jsonFile.url);
    const content = buildMessage(jsonFile.url, jsonFile.name, meta, expiry);

    await message.reply({ content, allowedMentions: { repliedUser: false } });

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

function parseMacro(jsonText) {
  try {
    const data = JSON.parse(jsonText);

    if (!Array.isArray(data) || data.length === 0) return null;

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

// ── Extract expiry from Discord CDN URL ───────────────────────────────────────

function getExpiry(url) {
  try {
    const ex = new URL(url).searchParams.get("ex");
    if (!ex) return null;
    return new Date(parseInt(ex, 16) * 1000);
  } catch {
    return null;
  }
}

// ── Build plain message ───────────────────────────────────────────────────────

function buildMessage(url, filename, meta, expiry) {
  const name = filename.replace(/\.json$/i, "");

  const expiryLine = expiry
    ? `-# ⚠️ Link expires <t:${Math.floor(expiry.getTime() / 1000)}:D>`
    : `-# ⚠️ Link may expire — re-upload to refresh it`;

  return [
    `-# Required Units: ${meta.units}`,
    `-# Steps: ${meta.totalSteps}`,
    `[${name}](${url})`,
    `[Click here to access the macro (Mobile)](${url})`,
    expiryLine,
  ].join("\n");
}

// ── Start ─────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
