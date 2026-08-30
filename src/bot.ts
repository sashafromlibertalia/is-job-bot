import {resolve} from 'node:path';
import {config} from 'dotenv';

config({path: resolve(__dirname, '../.env')});
import {Bot, GrammyError, HttpError} from "grammy";
import {createClient} from '@supabase/supabase-js'

const TRIGGER_COOLDOWN_MS = Number(process.env.TRIGGER_COOLDOWN_MS ?? 15_000);
const TOKEN = process.env.BOT_TOKEN || '';
const OFFTOP_CHAT_ID = process.env.OFFTOP_CHAT_ID || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const ADMIN_USER_ID = 319127347;

const bot = new Bot(TOKEN);

const client = createClient(SUPABASE_URL, SUPABASE_KEY)

const escapeMarkdownV2 = (text: string): string =>
    text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

const mentionUser = (user: { id: number; username?: string; first_name: string }): string =>
    user.username
        ? `@${escapeMarkdownV2(user.username)}`
        : `[${escapeMarkdownV2(user.first_name)}](tg://user?id=${user.id})`;

type AuthStatus = 'whitelisted' | 'offtop_member' | 'unauthorized';

type TriggerConfig = {
    words: string[];
    reply: string;
};

type CompiledTrigger = {
    regex: RegExp;
    reply: string;
    lastFired: number;
};

function loadTriggers(): CompiledTrigger[] {
    const raw = process.env.TRIGGERS;
    if (!raw) {
        console.warn('TRIGGERS env не задан, триггеры отключены');
        return [];
    }

    let parsed: TriggerConfig[];
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.error('Не удалось распарсить TRIGGERS (невалидный JSON):', e);
        return [];
    }

    if (!Array.isArray(parsed)) {
        console.error('TRIGGERS должен быть массивом');
        return [];
    }

    const compiled: CompiledTrigger[] = [];

    for (const t of parsed) {
        if (!t.words?.length || !t.reply) {
            console.warn('Пропущен невалидный триггер:', t);
            continue;
        }

        const escaped = t.words.map(w =>
            w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        );

        // Границы слова с поддержкой юникода (кириллица не входит в \w!)
        const pattern = `(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`;

        try {
            compiled.push({
                regex: new RegExp(pattern, 'iu'),
                reply: t.reply,
                lastFired: 0,
            });
        } catch (e) {
            console.error('Невалидный regex для триггера:', t, e);
        }
    }

    console.log(`Загружено триггеров: ${compiled.length}`);
    return compiled;
}

const triggers = loadTriggers();

async function checkAuthorization(userId: number): Promise<AuthStatus> {
    const {data, error} = await client
        .from('whitelist')
        .select('telegram_id')
        .eq('telegram_id', userId)
        .maybeSingle();

    if (error) {
        console.error('Supabase whitelist lookup failed:', error);
    }

    if (data) {
        return 'whitelisted';
    }

    const offtopUser = await bot.api.getChatMember(OFFTOP_CHAT_ID, userId);
    const isOfftopMember = !['left', 'kicked', 'restricted'].includes(offtopUser.status);

    return isOfftopMember ? 'offtop_member' : 'unauthorized';
}

bot.on("chat_member", async (ctx) => {
    const chatMember = ctx.update.chat_member?.new_chat_member;
    console.log(chatMember);

    if (!chatMember || chatMember.status !== "member") {
        return;
    }

    try {
        const status = await checkAuthorization(chatMember.user.id);

        switch (status) {
            case 'whitelisted':
                await ctx.reply(`*Внимание*: ${mentionUser(chatMember.user)} блатной\\. Ему можно тут быть`, {
                    parse_mode: 'MarkdownV2'
                });
                break;
            case 'offtop_member':
                // приветствие ставится реакцией на сервисное сообщение о входе (chat_member его не содержит)
                break;
            case 'unauthorized':
                await Promise.all([
                    ctx.reply(`${mentionUser(chatMember.user)} нет в ИС\\.Оффтопе\\. F`, {
                        parse_mode: 'MarkdownV2'
                    }),
                    bot.api.banChatMember(ctx.chatId, chatMember.user.id)
                ]);
                break;
        }
    } catch (e) {
        console.error(e);
    }
});

bot.on('message:new_chat_members', async (ctx) => {
    try {
        for (const user of ctx.message.new_chat_members) {
            if (await checkAuthorization(user.id) === 'offtop_member') {
                await ctx.react('👍');
                break;
            }
        }
    } catch (e) {
        console.error(e);
    }
});

bot.command('add', async (ctx) => {
    if (ctx.from?.id !== ADMIN_USER_ID) {
        return;
    }

    const arg = ctx.match.trim();
    const userId = Number(arg);

    if (!arg || isNaN(userId) || !Number.isInteger(userId)) {
        await ctx.reply('Использование: /add <USER_ID>');
        return;
    }

    const {error} = await client
        .from('whitelist')
        .insert({telegram_id: userId});

    if (error) {
        if (error.code === '23505') {
            await ctx.reply(`Пользователь ${userId} уже в вайтлисте.`);
        } else {
            console.error('Supabase insert error:', error);
            await ctx.reply(`Ошибка при добавлении: ${error.message}`);
        }
        return;
    }

    await Promise.all([
        ctx.reply(`Пользователь ${userId} добавлен в вайтлист.`),
        bot.api.unbanChatMember(ctx.chatId, userId),
    ]);
});

bot.command('ping', async (ctx) => {
    if (ctx.from?.id !== ADMIN_USER_ID) {
        return;
    }

    await ctx.reply("pong");
});

bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const now = Date.now();

    const matched = triggers.find(t => t.regex.test(text));
    if (!matched) return;

    if (now - matched.lastFired < TRIGGER_COOLDOWN_MS) {
        return; // недавно уже отвечали этим триггером — молчим
    }
    matched.lastFired = now;

    try {
        await ctx.reply(matched.reply);
    } catch (e) {
        console.error('Ошибка отправки триггер-ответа:', e);
    }
});

bot.start({
    allowed_updates: ['chat_member', 'message']
});

bot.catch(async (err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);

    const e = err.error;
    if (e instanceof GrammyError) {
        console.error("Error in request:", e.description);
    } else if (e instanceof HttpError) {
        console.error("Could not contact Telegram:", e);
    } else {
        console.error("Unknown error:", e);
    }
});
