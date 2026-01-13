import { type VoiceReceiver } from "@discordjs/voice";
import type { User } from "discord.js";
export declare function createListeningStream(receiver: VoiceReceiver, user: User): Promise<void>;
