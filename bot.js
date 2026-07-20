import { Client, GatewayIntentBits } from "discord.js";

const CHANNEL_ID = process.env.CHANNEL_ID;

if (!process.env.DISCORD_TOKEN) {
  throw new Error("bot token missing");
}

if (!CHANNEL_ID) {
  throw new Error("channel missing");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", (readyClient) => {
  console.log(`Ready`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isMainChannel = message.channel.id === CHANNEL_ID;

  const isThreadUnderChannel =
    message.channel.isThread() &&
    message.channel.parentId === CHANNEL_ID;

  if (!isMainChannel && !isThreadUnderChannel) return;

  const jsonAttachments = message.attachments.filter((attachment) =>
    attachment.name?.toLowerCase().endsWith(".json")
  );

  if (jsonAttachments.size === 0) return;

  for (const attachment of jsonAttachments.values()) {
    try {
      const response = await fetch(attachment.url);

      if (!response.ok) {
        throw new Error(
          `Failed: ${attachment.name}: HTTP ${response.status}`
        );
      }

      const jsonText = await response.text();
      const macroInfo = parseMacro(jsonText);

      if (!macroInfo) {
        await message.reply({
          content:
            `**${sanitizeFilename(attachment.name)}** is not a valid macro file.\n`,
          allowedMentions: {
            repliedUser: false,
          },
        });

        continue;
      }

      await message.reply({
        content: buildMessage(attachment, macroInfo),
        allowedMentions: {
          repliedUser: false,
        },
      });
    } catch (error) {
      console.error(`Error: ${attachment.name}:`, error);

      await message
        .reply({
          content: `Error: **${sanitizeFilename(
            attachment.name
          )}**.`,
          allowedMentions: {
            repliedUser: false,
          },
        })
        .catch(() => {});
    }
  }
});

function parseMacro(jsonText) {
  try {
    const actions = JSON.parse(jsonText);

    if (!Array.isArray(actions) || actions.length === 0) {
      return null;
    }

    const validActions = actions.filter(
      (action) =>
        action &&
        typeof action === "object" &&
        typeof action.Type === "string" &&
        action.Type.trim().length > 0
    );

    if (validActions.length === 0) {
      return null;
    }

    const unitSet = new Set();

    for (const action of validActions) {
      if (
        action.Type === "spawn_unit" &&
        typeof action.Unit === "string" &&
        action.Unit.trim().length > 0
      ) {
        const unitName = action.Unit.replace(/ #\d+$/, "").trim();

        if (unitName) {
          unitSet.add(unitName);
        }
      }
    }

    return {
      totalSteps: actions.length,
      units: unitSet.size > 0 ? [...unitSet].join(", ") : "None",
    };
  } catch {
    return null;
  }
}

function buildMessage(attachment, macroInfo) {
  const filename = sanitizeFilename(attachment.name);

  return [
    "## Macro Formatter",
    "",
    `**File:** \`${filename}\``,
    `**Total actions:** ${macroInfo.totalSteps}`,
    `**Required units:** ${macroInfo.units}`,
    "",
    "**URL:**",
    "```text",
    attachment.url,
    "```",
    `[Download ${filename}](${attachment.url})`,
  ].join("\n");
}

function sanitizeFilename(filename = "macro.json") {
  return filename.replaceAll("`", "").replaceAll("[", "").replaceAll("]", "");
}

client.login(process.env.DISCORD_TOKEN);
