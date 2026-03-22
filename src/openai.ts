import OpenAI from "openai";
import { appConfig } from "./config.js";

export const openai = new OpenAI({ apiKey: appConfig.openaiApiKey });
