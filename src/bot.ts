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

bot.on("chat_member", async (ctx) => {
    const chatMember = ctx.update.chat_member?.new_chat_member;
    if (!chatMember) {
        return;
    }

    switch (chatMember.status) {
        case "member":
            const {data, error} = await client
                .from('whitelist')
                .select('telegram_id')
                .eq('telegram_id', chatMember.user.id)
                .maybeSingle();

            if (error) {
                console.error('Supabase whitelist lookup failed:', error);
            }

            if (data) {
                await ctx.reply(`*Внимание*: ${mentionUser(chatMember.user)} блатной\\. Ему можно тут быть`, {
                    parse_mode: 'MarkdownV2'
                })

                return;
            }

            try {
                const offtopUser = await bot.api.getChatMember(OFFTOP_CHAT_ID, chatMember.user.id);
                const isOfftopMember = !['left', 'kicked', 'restricted'].includes(offtopUser.status)

                if (!isOfftopMember) {
                    await Promise.all([
                        ctx.reply(`${mentionUser(chatMember.user)} нет в ИС\\.Оффтопе\\. F`, {
                            parse_mode: 'MarkdownV2'
                        }),
                        bot.api.banChatMember(ctx.chatId, chatMember.user.id)
                    ])

                    return;
                }

                await ctx.reply(`Добро пожаловать в клуб, ${mentionUser(offtopUser.user)}`, {
                    parse_mode: 'MarkdownV2'
                })
            } catch (e) {
                console.error(e);

                await Promise.all([
                    ctx.reply(`Что-то пошло не так, но я на всякий случай тебя кикну, @${chatMember.user.username}. Пока.`),
                    bot.api.banChatMember(ctx.chatId, chatMember.user.id)
                ])
            }
            break;
        default:
            break;
    }
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
