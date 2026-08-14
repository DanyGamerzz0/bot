import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RENEW_COOLDOWN_MS = 5_000;
const RENEW_BUTTON_ID = "lixhub_renew_attachment_url";

const ALLOWED_CHANNEL_IDS = new Set(
  (process.env.CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (!DISCORD_TOKEN) {
  throw new Error("missing variable 1");
}

if (ALLOWED_CHANNEL_IDS.size === 0) {
  throw new Error("missing variable 2");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const renewCooldowns = new Map();

const uploadCommand = new SlashCommandBuilder()
  .setName("upload")
  .setDescription("Upload and format a LixHub macro or config file")
  .addAttachmentOption((option) =>
    option
      .setName("file")
      .setDescription("The macro or config JSON file")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("note")
      .setDescription("Optional note to display with the file")
      .setMaxLength(1000)
      .setRequired(false)
  );

const pinMessageCommand = new SlashCommandBuilder()
  .setName("pin-msg")
  .setDescription("Pin a message in a thread you own")
  .addStringOption((option) =>
    option
      .setName("messagelink")
      .setDescription("Link to a message in this thread")
      .setRequired(true)
  );

const unpinMessageCommand = new SlashCommandBuilder()
  .setName("unpin-msg")
  .setDescription("Unpin a message in a thread you own")
  .addStringOption((option) =>
    option
      .setName("messagelink")
      .setDescription("Link to a message in this thread")
      .setRequired(true)
  );

client.once("clientReady", async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Monitoring ${ALLOWED_CHANNEL_IDS.size} allowed channels...`);

  try {
    const commandData = [
      uploadCommand.toJSON(),
      pinMessageCommand.toJSON(),
      unpinMessageCommand.toJSON(),
    ];

    await readyClient.application.commands.set([]);

    for (const guild of readyClient.guilds.cache.values()) {
      const commands = await guild.commands.set(commandData);

      console.log(
        `Registered commands in ${guild.name}:`,
        commands.map((command) => ({
          name: command.name,
          description: command.description,
          options: command.options.map((option) => option.name),
        }))
      );
    }
  } catch (error) {
    console.error("Could not register slash command:", error);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!isAllowedLocation(message.channel)) return;

  const attachments = [...message.attachments.values()];
  const jsonAttachments = attachments.filter((attachment) =>
    attachment.name?.toLowerCase().endsWith(".json")
  );

  const containsOnlyJsonFiles =
    attachments.length > 0 && jsonAttachments.length === attachments.length;

  if (!containsOnlyJsonFiles) return;

  for (const attachment of jsonAttachments) {
    try {
      const formatted = await downloadAndParseFile(attachment);

      if (!formatted) {
        await message.reply({
          content: "This is not a valid LixHub macro or config file.",
          allowedMentions: { repliedUser: false },
        });
        continue;
      }

      const response = await message.reply({
        embeds: [buildEmbed(formatted.info, null, null)],
        files: [buildUpload(formatted)],
        allowedMentions: { repliedUser: false },
      });

      await applyFreshDownload(response, formatted.info, null);

      if (message.channel.isThread()) {
        await pinThreadStarter(message.channel);
      }
    } catch (error) {
      console.error("Error processing message attachment:", error);

      await message
        .reply({
          content: error.userMessage ?? "Something went wrong...",
          allowedMentions: { repliedUser: false },
        })
        .catch(() => {});
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && interaction.customId === RENEW_BUTTON_ID) {
    await renewAttachmentUrl(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (
    interaction.commandName === "pin-msg" ||
    interaction.commandName === "unpin-msg"
  ) {
    await handleThreadPinCommand(
      interaction,
      interaction.commandName === "pin-msg"
    );
    return;
  }

  if (interaction.commandName !== "upload") return;

  if (!interaction.channel || !isAllowedLocation(interaction.channel)) {
    await interaction.reply({
      content: "This command cannot be used here.",
      ephemeral: true,
    });
    return;
  }

  const attachment = interaction.options.getAttachment("file", true);
  const note = interaction.options.getString("note")?.trim() || null;

  if (!attachment.name?.toLowerCase().endsWith(".json")) {
    await interaction.reply({
      content: "Please upload a file ending in `.json`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const formatted = await downloadAndParseFile(attachment);

    if (!formatted) {
      await interaction.editReply({
        content: "This is not a valid LixHub macro or config file.",
      });
      return;
    }

    const response = await interaction.editReply({
      embeds: [buildEmbed(formatted.info, note, null)],
      files: [buildUpload(formatted)],
    });

    await applyFreshDownload(response, formatted.info, note);

    if (interaction.channel?.isThread()) {
      await pinThreadStarter(interaction.channel);
    }
  } catch (error) {
    console.error("Error processing slash command:", error);

    await interaction.editReply({
      content: error.userMessage ?? "Something went wrong...",
      embeds: [],
      components: [],
    });
  }
});

function isAllowedLocation(channel) {
  const isAllowedChannel = ALLOWED_CHANNEL_IDS.has(channel.id);
  const isThreadInAllowedChannel =
    channel.isThread() && ALLOWED_CHANNEL_IDS.has(channel.parentId);

  return isAllowedChannel || isThreadInAllowedChannel;
}

function parseDiscordMessageLink(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    const allowedHosts = new Set([
      "discord.com",
      "www.discord.com",
      "canary.discord.com",
      "ptb.discord.com",
      "discordapp.com",
      "www.discordapp.com",
    ]);

    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[0] !== "channels") return null;

    const [, guildId, channelId, messageId] = parts;
    if (![guildId, channelId, messageId].every((id) => /^\d+$/.test(id))) {
      return null;
    }

    return { guildId, channelId, messageId };
  } catch {
    return null;
  }
}

async function handleThreadPinCommand(interaction, shouldPin) {
  if (!interaction.channel || !isAllowedLocation(interaction.channel)) {
    await interaction.reply({
      content: "This command cannot be used here.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.channel.isThread()) {
    await interaction.reply({
      content: "This command can only be used inside a thread.",
      ephemeral: true,
    });
    return;
  }

  let thread = interaction.channel;
  if (!thread.ownerId) {
    thread = await thread.fetch().catch(() => thread);
  }

  if (thread.ownerId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the owner of this thread can use this command.",
      ephemeral: true,
    });
    return;
  }

  const link = parseDiscordMessageLink(
    interaction.options.getString("messagelink", true)
  );

  if (!link) {
    await interaction.reply({
      content: "Please provide a valid Discord message link.",
      ephemeral: true,
    });
    return;
  }

  if (link.guildId !== interaction.guildId || link.channelId !== thread.id) {
    await interaction.reply({
      content: "That message must belong to this thread.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const message = await thread.messages.fetch(link.messageId);

    if (shouldPin && message.pinned) {
      await interaction.editReply("That message is already pinned.");
      return;
    }

    if (!shouldPin && !message.pinned) {
      await interaction.editReply("That message is not pinned.");
      return;
    }

    const auditReason = `${shouldPin ? "Pinned" : "Unpinned"} by thread owner ${interaction.user.tag}`;
    if (shouldPin) {
      await message.pin(auditReason);
    } else {
      await message.unpin(auditReason);
    }

    await interaction.editReply(
      shouldPin ? "Message pinned successfully." : "Message unpinned successfully."
    );
  } catch (error) {
    console.error(`Could not ${shouldPin ? "pin" : "unpin"} message:`, error);

    const missingPermissions = error.code === 50013;
    await interaction.editReply(
      missingPermissions
        ? "I need the Manage Messages permission to do that."
        : "I could not find or update that message."
    );
  }
}

function userError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

async function fetchWithLimit(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Attachment download returned HTTP ${response.status}`);
    }

    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_JSON_BYTES) {
      throw userError("That JSON file is too large. The limit is 8 MB.");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_JSON_BYTES) {
      throw userError("That JSON file is too large. The limit is 8 MB.");
    }

    return bytes;
  } catch (error) {
    if (error.name === "AbortError") {
      throw userError("The attachment download timed out. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadAndParseFile(attachment) {
  if (Number.isFinite(attachment.size) && attachment.size > MAX_JSON_BYTES) {
    throw userError("That JSON file is too large. The limit is 8 MB.");
  }

  const bytes = await fetchWithLimit(attachment.url);
  const jsonText = bytes.toString("utf8");
  const info = parseLixHubFile(jsonText);

  if (!info) return null;

  return {
    info,
    bytes,
    originalName: attachment.name || "lixhub-file.json",
  };
}

function parseLixHubFile(jsonText) {
  let parsedData;

  try {
    parsedData = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (
    isPlainObject(parsedData) &&
    typeof parsedData.Name === "string" &&
    parsedData.Name.trim() &&
    isPlainObject(parsedData.Data)
  ) {
    return {
      type: "config",
      configName: parsedData.Name.trim(),
    };
  }

  const actions = Array.isArray(parsedData) ? parsedData : parsedData?.Actions;
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const validActions = actions.filter(
    (action) =>
      isPlainObject(action) &&
      typeof action.Type === "string" &&
      action.Type.trim().length > 0
  );

  if (validActions.length === 0) return null;

  const units = new Set();

  for (const action of validActions) {
    const actionType = action.Type.trim().toLowerCase();
    const isPlacementAction =
      actionType === "place" || actionType === "place_phantom";

    if (
      isPlacementAction &&
      typeof action.Label === "string" &&
      action.Label.trim()
    ) {
      const unitName = cleanUnitName(action.Label);
      if (unitName) units.add(unitName);
    }
  }

  return {
    type: "macro",
    totalSteps: validActions.length,
    units: units.size > 0 ? [...units].join(", ") : "None",
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanUnitName(label) {
  return label.replace(/ #\d+$/i, "").replace(/\s+/g, " ").trim();
}

function truncate(value, maximum = 1024) {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 3))}...`;
}

function safeFileName(value, fallback) {
  const cleaned = String(value ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  return cleaned || fallback;
}

function formattedFileName(formatted) {
  if (formatted.info.type === "config") {
    return `${safeFileName(formatted.info.configName, "LixHub Config")}.json`;
  }

  const original = safeFileName(formatted.originalName, "LixHub Macro.json");
  return original.toLowerCase().endsWith(".json") ? original : `${original}.json`;
}

function buildUpload(formatted) {
  return {
    attachment: formatted.bytes,
    name: formattedFileName(formatted),
  };
}

function expirationFromUrl(url) {
  try {
    const encodedExpiry = new URL(url).searchParams.get("ex");
    if (!encodedExpiry) return null;

    const timestamp = Number.parseInt(encodedExpiry, 16);
    return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
  } catch {
    return null;
  }
}

function expirationText(url) {
  const timestamp = url ? expirationFromUrl(url) : null;
  return timestamp
    ? `<t:${timestamp}:R>  -  <t:${timestamp}:f>`
    : url
      ? "Expiration unavailable"
      : "Preparing download...";
}

function buildEmbed(info, note, url) {
  const embed = new EmbedBuilder();

  if (info.type === "config") {
    embed
      .setTitle("Config Formatter")
      .addFields(
        {
          name: "Config name",
          value: truncate(info.configName),
          inline: false,
        },
        {
          name: "Link expires",
          value: expirationText(url),
          inline: false,
        }
      );
  } else {
    embed
      .setTitle("Macro Formatter")
      .addFields(
        {
          name: "Total actions",
          value: String(info.totalSteps),
          inline: true,
        },
        {
          name: "Required units",
          value: truncate(info.units),
          inline: true,
        },
        {
          name: "URL",
          value: url
            ? truncate(
                [
                  "```text",
                  url,
                  "```",
                  `Link expires: ${expirationText(url)}`,
                ].join("\n")
              )
            : "Preparing download...",
          inline: false,
        }
      );
  }

  if (note) {
    embed.addFields({
      name: "Note from the user:",
      value: truncate(note),
      inline: false,
    });
  }

  return embed;
}

function buildButtons(url, info) {
  const label = info.type === "config" ? "Download Config" : "Download Macro";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(label)
      .setStyle(ButtonStyle.Link)
      .setURL(url),
    new ButtonBuilder()
      .setCustomId(RENEW_BUTTON_ID)
      .setLabel("Renew URL")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function applyFreshDownload(message, info, note) {
  const attachment = message.attachments.first();
  if (!attachment) throw new Error("Formatted response has no attachment");

  await message.edit({
    embeds: [buildEmbed(info, note, attachment.url)],
    components: [buildButtons(attachment.url, info)],
  });
}

function infoFromFormatterMessage(message) {
  const embed = message.embeds[0];
  if (!embed) return null;

  if (embed.title === "Config Formatter") {
    const nameField = embed.fields.find((field) => field.name === "Config name");
    return {
      type: "config",
      configName: nameField?.value || "LixHub Config",
    };
  }

  if (embed.title === "Macro Formatter") {
    const actionsField = embed.fields.find((field) => field.name === "Total actions");
    const unitsField = embed.fields.find((field) => field.name === "Required units");
    return {
      type: "macro",
      totalSteps: Number(actionsField?.value) || 0,
      units: unitsField?.value || "None",
    };
  }

  return null;
}

function noteFromFormatterMessage(message) {
  const noteField = message.embeds[0]?.fields.find(
    (field) => field.name === "Note from the user:"
  );
  return noteField?.value || null;
}

async function renewAttachmentUrl(interaction) {
  if (!interaction.channel || !isAllowedLocation(interaction.channel)) {
    await interaction.reply({
      content: "This button cannot be used here.",
      ephemeral: true,
    });
    return;
  }

  const cooldownUntil = renewCooldowns.get(interaction.message.id) ?? 0;
  const remaining = cooldownUntil - Date.now();

  if (remaining > 0) {
    await interaction.reply({
      content: `Please wait ${Math.ceil(remaining / 1000)} second(s) before renewing again.`,
      ephemeral: true,
    });
    return;
  }

  renewCooldowns.set(interaction.message.id, Date.now() + RENEW_COOLDOWN_MS);
  await interaction.deferReply({ ephemeral: true });

  try {
    const message = await interaction.message.fetch();
    const info = infoFromFormatterMessage(message);
    const note = noteFromFormatterMessage(message);
    const attachment = message.attachments.first();

    if (!info || !attachment) {
      throw userError("This formatter message no longer has a renewable file.");
    }

    const bytes = await fetchWithLimit(attachment.url);

    // Re-uploading creates a new attachment signature. The message itself is
    // the persistent storage, so renewal requires no database or memory state.
    const reuploaded = await message.edit({
      attachments: [],
      files: [
        {
          attachment: bytes,
          name: safeFileName(attachment.name, "lixhub-file.json"),
        },
      ],
      components: [],
    });

    const freshAttachment = reuploaded.attachments.first();
    if (!freshAttachment) throw new Error("Renewed message has no attachment");

    await reuploaded.edit({
      embeds: [buildEmbed(info, note, freshAttachment.url)],
      components: [buildButtons(freshAttachment.url, info)],
    });

    await interaction.editReply({
      content: `Download URL renewed. It now expires ${expirationText(freshAttachment.url)}.`,
    });
  } catch (error) {
    console.error("Could not renew attachment URL:", error);
    await interaction.editReply({
      content: error.userMessage ?? "Could not renew this download URL.",
    });
  }
}

async function pinThreadStarter(thread) {
  try {
    const starterMessage = await thread.fetchStarterMessage();
    if (!starterMessage) return;

    const pinnedMessages = await thread.messages.fetchPinned();
    if (pinnedMessages.has(starterMessage.id)) return;

    await starterMessage.pin();
  } catch (error) {
    console.warn(`Could not pin thread ${thread.id}:`, error.message);
  }
}

client.login(DISCORD_TOKEN);
