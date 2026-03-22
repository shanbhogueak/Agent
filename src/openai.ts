import OpenAI, { AzureOpenAI } from "openai";
import { appConfig } from "./config.js";

export const openai: OpenAI = createClient();

function createClient(): OpenAI {
  if (appConfig.openaiProvider === "azure") {
    const azureClient = new AzureOpenAI({
      apiKey: appConfig.azureOpenaiApiKey,
      apiVersion: appConfig.azureOpenaiApiVersion,
      endpoint: appConfig.azureOpenaiBaseUrl ? undefined : appConfig.azureOpenaiEndpoint,
      baseURL: appConfig.azureOpenaiBaseUrl,
      deployment: appConfig.azureOpenaiDeployment,
    });
    return azureClient;
  }

  return new OpenAI({
    apiKey: appConfig.openaiApiKey,
    baseURL: appConfig.openaiBaseUrl,
  });
}
