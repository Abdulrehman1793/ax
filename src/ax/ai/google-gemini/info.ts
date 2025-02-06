import type { AxModelInfo } from '../types.js'

import { AxAIGoogleGeminiModel } from './types.js'

/**
 * AxAIGoogleGemini: Model information
 */
export const axModelInfoGoogleGemini: AxModelInfo[] = [
  {
    name: AxAIGoogleGeminiModel.Gemini20Pro,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 0.0,
    completionTokenCostPer1M: 0.0,
  },
  {
    name: AxAIGoogleGeminiModel.Gemini20Flash,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 0.01,
    completionTokenCostPer1M: 0.4,
  },

  {
    name: AxAIGoogleGeminiModel.Gemini20FlashLite,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 0.0,
    completionTokenCostPer1M: 0.0,
  },
  {
    name: AxAIGoogleGeminiModel.Gemini20FlashThinking,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 0.0,
    completionTokenCostPer1M: 0.0,
  },
  {
    name: AxAIGoogleGeminiModel.Gemini15Flash,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 0.075,
    completionTokenCostPer1M: 0.3,
  },
  {
    name: AxAIGoogleGeminiModel.Gemini15Flash8B,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 0.0375,
    completionTokenCostPer1M: 0.15,
  },
  {
    name: AxAIGoogleGeminiModel.Gemini15Pro,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 1.25,
    completionTokenCostPer1M: 5.0,
  },
  {
    name: AxAIGoogleGeminiModel.Gemini1Pro,
    currency: 'usd',
    characterIsToken: false,
    promptTokenCostPer1M: 0.5,
    completionTokenCostPer1M: 1.5,
  },
]
