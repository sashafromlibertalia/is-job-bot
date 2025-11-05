import 'dotenv/config';
import {Bot, GrammyError, HttpError} from "grammy";
import * as process from "node:process";

const TOKEN = process.env.BOT_TOKEN || '';
const OFFTOP_CHAT_ID = process.env.OFFTOP_CHAT_ID || '';

const WHITELIST = process.env.WHITELIST_ID?.split(' ').map(id => +id) ?? []

const bot = new Bot(TOKEN);

bot.on("chat_member", async (ctx) => {
    const chatMember = ctx.update.chat_member?.new_chat_member;
    if (!chatMember) {
        return;
    }

    switch (chatMember.status) {
        case "member":
            const isInWhitelist = WHITELIST.includes(chatMember.user.id)

            if (isInWhitelist) {
                await ctx.reply(`*Внимание*: @${chatMember.user.username} блатной\\. Ему можно тут быть`, {
                    parse_mode: 'MarkdownV2'
                })

                return;
            }

            try {
                const offtopUser = await bot.api.getChatMember(OFFTOP_CHAT_ID, chatMember.user.id);
                const isOfftopMember = !['left', 'kicked', 'restricted'].includes(offtopUser.status)

                if (!isOfftopMember) {
                    await Promise.all([
                        ctx.reply(`*@${chatMember.user.username}* нет в ИС\\.Оффтопе\\. F`, {
                            parse_mode: 'MarkdownV2'
                        }),
                        bot.api.banChatMember(ctx.chatId, chatMember.user.id)
                    ])

                    return;
                }

                await ctx.reply(`Добро пожаловать в клуб, *@${offtopUser.user.username}*`, {
                    parse_mode: 'MarkdownV2'
                })
            } catch (e) {
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

bot.start({
    allowed_updates: ['chat_member']
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
