import type { ChatInputCommandInteraction, Snowflake } from "discord.js";
declare function join(interaction: ChatInputCommandInteraction<"cached">, recordable: Set<Snowflake>): Promise<void>;
export declare const interactionHandlers: Map<string, typeof join>;
export {};
