import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required to see attachments + content
  ],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  // Ignore bots and messages outside threads
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  // Look for a .json attachment
  const jsonFile = message.attachments.find((a) =>
    a.name?.toLowerCase().endsWith(".json")
  );
  if (!jsonFile) return;

  try {
    // 1. Fetch and parse the macro
    const res = await fetch(jsonFile.url);
    const text = await res.text();
    const meta = parseMacro(text);

    // 2. If the file is invalid, send the error message and stop
    if (meta === null) {
      await message.reply("Macro is invalid/corrupted. Copying to clipboard is not recommended.");
      return;
    }

    // 3. Reply to the message with an embed
    const embed = buildEmbed(jsonFile.url, jsonFile.name, meta);
    await message.reply({ embeds: [embed] });

    // 4. Pin the first (starter) message of the thread
    await pinThreadStarter(message.channel);
  } catch (err) {
    console.error("Error handling macro upload:", err);
    await message.reply("⚠️ Something went wrong processing that file.").catch(() => {});
  }
});

// ── Pin the thread's first message ───────────────────────────────────────────

async function pinThreadStarter(thread) {
  try {
    // The starter message is the one that opened the thread
    const starter = await thread.fetchStarterMessage();
    if (!starter) return;

    // Don't try to pin if it's already pinned
    const pins = await thread.messages.fetchPinned();
    if (pins.has(starter.id)) return;

    await starter.pin();
  } catch (err) {
    // Missing Permissions or other Discord errors — log and move on
    console.warn("Could not pin starter message:", err.message);
  }
}

// ── Parse macro JSON ──────────────────────────────────────────────────────────

function parseMacro(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    const actions = Array.isArray(data) ? data : [];

    const totalSteps = actions.length || data.totalSteps || "Unknown";

    const unitSet = new Set();
    for (const action of actions) {
      if (action.Type === "spawn_unit" && action.Unit) {
        unitSet.add(action.Unit.replace(/ #\d+$/, ""));
      }
    }

    const units =
      unitSet.size > 0 ? [...unitSet].join(", ") : "None found";

    return { totalSteps, units };
  } catch {
    return null; // signals invalid/corrupted file
  }
}

// ── Build the Discord embed ───────────────────────────────────────────────────

function buildEmbed(url, filename, meta) {
  return new EmbedBuilder()
    .setTitle("Macro uploaded")
    .setColor(0x5865f2)
    .addFields(
      {
        name: "Download link",
        value: `[${filename}](${url})\n\`\`\`\n${url}\n\`\`\``,
        inline: false,
      },
      {
        name: "Total steps",
        value: String(meta.totalSteps),
        inline: true,
      },
      {
        name: "Units",
        value: meta.units,
        inline: false,
      }
    )
    .setFooter({ text: "https://discord.gg/cYKnXE2Nf8" })
    .setTimestamp();
}

// ── Start ─────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
