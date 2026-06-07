require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior
} = require('@discordjs/voice');

const { spawn } = require('child_process');
const http = require('http');

// ============================================================
// KEEP-ALIVE SERVER (for UptimeRobot pings)
// ============================================================
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive!');
}).listen(process.env.PORT || 3000, () => {
  console.log('Keep-alive server running');
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const queues = new Map();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ============================================================
// BUTTONS
// ============================================================
function getButtons(loopMode, autoplay) {
  const loopLabel =
    loopMode === 0 ? '🔁 OFF' :
    loopMode === 1 ? '🔂 SONG' :
    '🔁 QUEUE';

  const autoplayLabel = autoplay ? '✅ AutoPlay' : '❎ AutoPlay';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setLabel('⏸').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('resume').setLabel('▶️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('skip').setLabel('⏭').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('loop').setLabel(loopLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('autoplay').setLabel(autoplayLabel).setStyle(autoplay ? ButtonStyle.Success : ButtonStyle.Danger)
  );
}

// ============================================================
// LANGUAGE DETECTION
// ============================================================
function detectLanguage(title) {
  if (!title) return null;

  if (/[\u0B80-\u0BFF]/.test(title)) return 'Tamil';
  if (/[\u0900-\u097F]/.test(title)) return 'Hindi';
  if (/[\u0C00-\u0C7F]/.test(title)) return 'Telugu';
  if (/[\u0D00-\u0D7F]/.test(title)) return 'Malayalam';
  if (/[\u0C80-\u0CFF]/.test(title)) return 'Kannada';
  if (/[\u0A00-\u0A7F]/.test(title)) return 'Punjabi';
  if (/[\u0980-\u09FF]/.test(title)) return 'Bengali';

  const lower = title.toLowerCase();
  if (/\btamil\b/.test(lower))              return 'Tamil';
  if (/\bhindi\b|\bbollywood\b/.test(lower)) return 'Hindi';
  if (/\btelugu\b/.test(lower))             return 'Telugu';
  if (/\bmalayalam\b/.test(lower))          return 'Malayalam';
  if (/\bkannada\b/.test(lower))            return 'Kannada';
  if (/\bpunjabi\b/.test(lower))            return 'Punjabi';
  if (/\bbengali\b/.test(lower))            return 'Bengali';

  return null;
}

function isDifferentLanguage(entryTitle, wantedLang) {
  const detected = detectLanguage(entryTitle);
  if (!wantedLang) return detected !== null;
  if (!detected) return false;
  return detected !== wantedLang;
}

// ============================================================
// AUTOPLAY HELPER
// ============================================================
function pickFromEntries(entries, lastSong, playedUrls, language) {
  const coreSongName = lastSong.title
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/\|.*/g, '')
    .replace(/official|video|audio|lyric|lyrics|hd|4k|music|full\s*song/gi, '')
    .replace(/@\w+/g, '')
    .trim()
    .toLowerCase();

  const coreWords = coreSongName.split(/[\s\-–—,]+/).filter(w => w.length > 3);

  return entries.find(e => {
    if (!e.id) return false;
    const entryUrl = `https://www.youtube.com/watch?v=${e.id}`;
    if (lastSong.url.includes(e.id)) return false;
    if (playedUrls && playedUrls.has(entryUrl)) return false;
    if (isDifferentLanguage(e.title || '', language)) return false;

    const entryTitle = (e.title || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '');
    const matchCount = coreWords.filter(w => entryTitle.includes(w)).length;
    return matchCount < Math.ceil(coreWords.length * 0.5);
  }) || null;
}

async function fetchRelatedSong(lastSong, playedUrls, language) {
  const videoIdMatch = lastSong.url.match(/[?&]v=([^&]+)/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;

  if (videoId) {
    const radioUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    console.log(`[AutoPlay] Trying YouTube Radio mix for ${videoId} (lang: ${language || 'any'})`);

    const result = await new Promise((resolve) => {
      const proc = spawn('./yt-dlp', [
        '--flat-playlist',
        '--dump-single-json',
        '--playlist-start', '2',
        '--playlist-end', '20',
        radioUrl
      ]);

      let output = '';
      proc.stdout.on('data', chunk => output += chunk);
      proc.on('close', () => {
        try {
          const json = JSON.parse(output);
          const entries = json.entries || [];
          const pick = pickFromEntries(entries, lastSong, playedUrls, language);
          resolve(pick ? {
            title: pick.title || 'Unknown',
            url: `https://www.youtube.com/watch?v=${pick.id}`
          } : null);
        } catch {
          resolve(null);
        }
      });
      proc.on('error', () => resolve(null));
    });

    if (result) {
      console.log(`[AutoPlay] Radio found: ${result.title}`);
      return result;
    }
  }

  const rawTitle = lastSong.title;
  let artist = null;
  const dashFormat = rawTitle.match(/^(.+?)\s+[-–]\s+/);
  if (dashFormat) {
    artist = dashFormat[1].replace(/@/g, '').trim();
  } else {
    const handleMatch = rawTitle.match(/@([\w]+)/);
    if (handleMatch) artist = handleMatch[1];
  }

  const langTag = language ? ` ${language}` : '';
  const searchQuery = artist
    ? `${artist}${langTag} songs`
    : `${langTag} songs hits`.trim();

  console.log(`[AutoPlay] Fallback search: "${searchQuery}"`);

  return new Promise((resolve) => {
    const search = spawn('./yt-dlp', [
      `ytsearch25:${searchQuery}`,
      '--dump-single-json',
      '--flat-playlist'
    ]);

    let output = '';
    search.stdout.on('data', chunk => output += chunk);
    search.on('close', () => {
      try {
        const json = JSON.parse(output);
        const entries = json.entries || [];
        const pick = pickFromEntries(entries, lastSong, playedUrls, language);
        resolve(pick ? {
          title: pick.title || 'Unknown',
          url: `https://www.youtube.com/watch?v=${pick.id}`
        } : null);
      } catch (err) {
        console.error('[AutoPlay] fallback error:', err.message);
        resolve(null);
      }
    });
    search.on('error', () => resolve(null));
  });
}

// ============================================================
// PLAY NEXT
// ============================================================
async function playNext(guildId) {
  const data = queues.get(guildId);
  if (!data) return;

  if (data.loopMode === 1 && data.current) {
    data.queue.unshift(data.current);
  }

  let song = data.queue.shift();

  if (!song) {
    if (data.loopMode === 2 && data.history.length) {
      data.queue = [...data.history];
      data.history = [];
      return playNext(guildId);
    }

    if (data.autoplay && data.current) {
      data.textChannel.send('🔎 Queue empty — fetching autoplay suggestion...');
      const related = await fetchRelatedSong(data.current, data.playedUrls, data.language);
      if (related) {
        data.queue.push(related);
        song = data.queue.shift();
      }
    }

    if (!song) {
      data.textChannel.send('📭 Queue finished. Disconnecting.');
      data.connection.destroy();
      queues.delete(guildId);
      return;
    }
  }

  data.current = song;
  data.history.push(song);
  if (data.history.length > 50) data.history.shift();

  const detectedLang = detectLanguage(song.title);
  if (detectedLang) data.language = detectedLang;

  data.playedUrls.add(song.url);
  if (data.playedUrls.size > 100) {
    const first = data.playedUrls.values().next().value;
    data.playedUrls.delete(first);
  }

  try {
    const process = spawn('./yt-dlp', [
      '-f', 'bestaudio',
      '-o', '-',
      '--quiet',
      song.url
    ]);

    const resource = createAudioResource(process.stdout);
    data.player.play(resource);

    const embed = new EmbedBuilder()
      .setTitle('🎶 Now Playing')
      .setDescription(`[${song.title}](${song.url})`)
      .setColor(0x00ff00)
      .setFooter({ text: `AutoPlay: ${data.autoplay ? 'ON ✅' : 'OFF ❎'} | Loop: ${['OFF','SONG','QUEUE'][data.loopMode]}${data.language ? ` | 🌐 ${data.language}` : ''}` });

    data.textChannel.send({
      embeds: [embed],
      components: [getButtons(data.loopMode, data.autoplay)]
    });

  } catch (err) {
    console.error(err);
    playNext(guildId);
  }
}

// ============================================================
// INTERACTIONS
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;

  try {

    // ==========================
    // BUTTONS
    // ==========================
    if (interaction.isButton()) {
      const data = queues.get(guildId);
      if (!data) return interaction.reply({ content: '❌ Nothing playing', ephemeral: true });

      if (interaction.customId === 'pause') {
        data.player.pause();
        return interaction.reply({ content: '⏸ Paused', ephemeral: true });
      }

      if (interaction.customId === 'resume') {
        data.player.unpause();
        return interaction.reply({ content: '▶️ Resumed', ephemeral: true });
      }

      if (interaction.customId === 'skip') {
        data.player.stop();
        return interaction.reply({ content: '⏭ Skipped', ephemeral: true });
      }

      if (interaction.customId === 'loop') {
        data.loopMode = (data.loopMode + 1) % 3;
        const modes = ['OFF', 'SONG', 'QUEUE'];
        return interaction.reply({ content: `🔁 Loop: ${modes[data.loopMode]}`, ephemeral: true });
      }

      if (interaction.customId === 'autoplay') {
        data.autoplay = !data.autoplay;
        return interaction.reply({
          content: `🎵 AutoPlay is now **${data.autoplay ? 'ON ✅' : 'OFF ❎'}**`,
          ephemeral: true
        });
      }
    }

    if (!interaction.isChatInputCommand()) return;

    // ==========================
    // /autoplay COMMAND
    // ==========================
    if (interaction.commandName === 'autoplay') {
      const data = queues.get(guildId);
      if (!data) return interaction.reply('❌ Nothing is playing right now');

      data.autoplay = !data.autoplay;
      return interaction.reply(
        `🎵 AutoPlay is now **${data.autoplay ? 'ON ✅ — I will keep playing related songs when the queue ends' : 'OFF ❎'}**`
      );
    }

    // ==========================
    // /playnow COMMAND
    // ==========================
    if (interaction.commandName === 'playnow') {
      await interaction.deferReply();

      const data = queues.get(guildId);
      if (!data) return interaction.editReply('❌ Nothing is playing');

      const input = interaction.options.getString('query');
      let selectedSong = null;

      if (!isNaN(input)) {
        const index = parseInt(input) - 1;
        if (index >= 0 && index < data.queue.length) {
          selectedSong = data.queue.splice(index, 1)[0];
        }
      }

      if (!selectedSong) {
        const search = spawn('./yt-dlp', [`ytsearch1:${input}`, '--dump-single-json']);
        let output = '';
        search.stdout.on('data', chunk => output += chunk);
        await new Promise(resolve => search.on('close', resolve));

        try {
          const json = JSON.parse(output);
          selectedSong = { title: json.title, url: json.webpage_url };
        } catch {
          return interaction.editReply('❌ Song not found');
        }
      }

      if (data.current) data.queue.unshift(data.current);
      data.queue.unshift(selectedSong);
      data.player.stop();

      return interaction.editReply(`🎶 Now playing: **${selectedSong.title}**`);
    }

    // ==========================
    // /play COMMAND
    // ==========================
    if (interaction.commandName === 'play') {
      await interaction.deferReply();

      const channel = interaction.member.voice.channel;
      if (!channel) return interaction.editReply('❌ Join a voice channel first');

      const query = interaction.options.getString('song');

      try {
        let songs = [];
        const isPlaylist = query.includes('list=');

        if (isPlaylist) {
          const proc = spawn('./yt-dlp', ['--flat-playlist', '--dump-single-json', query]);
          let raw = '';
          proc.stdout.on('data', chunk => raw += chunk);
          proc.on('close', () => {
            try {
              const json = JSON.parse(raw);
              if (!json.entries?.length) return interaction.editReply('❌ Could not load playlist');
              songs = json.entries.slice(0, 100).map(v => ({
                title: v.title || 'Unknown',
                url: `https://www.youtube.com/watch?v=${v.id}`
              }));
              addToQueue();
            } catch (err) {
              console.error(err);
              interaction.editReply('❌ Playlist parsing failed');
            }
          });
          return;
        }

        const search = spawn('./yt-dlp', [`ytsearch1:${query}`, '--dump-single-json']);
        let output = '';
        search.stdout.on('data', chunk => output += chunk);
        search.on('close', () => {
          try {
            const json = JSON.parse(output);
            songs.push({ title: json.title, url: json.webpage_url });
            addToQueue();
          } catch (err) {
            console.error(err);
            interaction.editReply('❌ Failed to find song');
          }
        });

        function addToQueue() {
          let data = queues.get(guildId);

          if (!data) {
            const connection = joinVoiceChannel({
              channelId: channel.id,
              guildId: channel.guild.id,
              adapterCreator: channel.guild.voiceAdapterCreator
            });

            const player = createAudioPlayer({
              behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });

            connection.subscribe(player);

            data = {
              connection,
              player,
              queue: [],
              history: [],
              current: null,
              loopMode: 0,
              autoplay: false,
              language: null,
              playedUrls: new Set(),
              textChannel: interaction.channel
            };

            queues.set(guildId, data);

            player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
            player.on('error', (err) => {
              console.error(err);
              playNext(guildId);
            });
          }

          data.queue.push(...songs);
          if (!data.current) playNext(guildId);

          interaction.editReply(`✅ Added **${songs.length}** track(s) to queue`);
        }

      } catch (err) {
        console.error(err);
        interaction.editReply('❌ Error occurred');
      }
    }

    // ==========================
    // /skip
    // ==========================
    if (interaction.commandName === 'skip') {
      const data = queues.get(guildId);
      if (!data) return interaction.reply('❌ Nothing playing');
      data.player.stop();
      interaction.reply('⏭ Skipped');
    }

    // ==========================
    // /stop
    // ==========================
    if (interaction.commandName === 'stop') {
      const data = queues.get(guildId);
      if (!data) return interaction.reply('❌ Nothing playing');
      data.queue = [];
      data.history = [];
      data.player.stop();
      data.connection.destroy();
      queues.delete(guildId);
      interaction.reply('🛑 Stopped');
    }

    // ==========================
    // /pause
    // ==========================
    if (interaction.commandName === 'pause') {
      const data = queues.get(guildId);
      if (!data) return interaction.reply('❌ Nothing playing');
      data.player.pause();
      interaction.reply('⏸ Paused');
    }

    // ==========================
    // /resume
    // ==========================
    if (interaction.commandName === 'resume') {
      const data = queues.get(guildId);
      if (!data) return interaction.reply('❌ Nothing playing');
      data.player.unpause();
      interaction.reply('▶️ Resumed');
    }

    // ==========================
    // /loop
    // ==========================
    if (interaction.commandName === 'loop') {
      const data = queues.get(guildId);
      if (!data) return interaction.reply('❌ Nothing playing');
      data.loopMode = (data.loopMode + 1) % 3;
      const modes = ['OFF', 'SONG', 'QUEUE'];
      interaction.reply(`🔁 Loop: ${modes[data.loopMode]}`);
    }

    // ==========================
    // /queue
    // ==========================
    if (interaction.commandName === 'queue') {
      const data = queues.get(guildId);
      if (!data || !data.queue.length) return interaction.reply('📭 Queue is empty');
      const list = data.queue.slice(0, 10).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
      interaction.reply(`📜 **Queue:**\n${list}`);
    }

  } catch (error) {
    console.error('Interaction error:', error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '❌ Something went wrong!', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ Something went wrong!', ephemeral: true });
      }
    } catch (e) {
      // interaction expired, ignore silently
    }
  }
});

client.login(process.env.TOKEN);
