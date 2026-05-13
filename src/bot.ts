import 'dotenv/config';
import {Bot, GrammyError, HttpError} from "grammy";
import {createClient} from '@supabase/supabase-js'

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
                await ctx.reply(`Добро пожаловать в клуб, ${mentionUser(chatMember.user)}`, {
                    parse_mode: 'MarkdownV2'
                });
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
