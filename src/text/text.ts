import {
  finalResultFunc,
  functionsToJSON,
  processFunction,
} from './functions.js';
import { Memory } from './memory.js';
import {
  AIGenerateTextTrace,
  AIMemory,
  AIService,
  AITextResponse,
  GenerateTextExtraOptions,
  GenerateTextResponse,
  PromptConfig,
} from './types.js';
import { stringToObject } from './util.js';
import { AI, RateLimiterFunction } from './wrap.js';

export type Options = {
  sessionId?: string;
  memory?: AIMemory;
  rateLimiter?: RateLimiterFunction;
};

/**
 * The main class for various text generation tasks
 * @export
 */
export class AIPrompt<T> {
  private conf: Readonly<PromptConfig<T>>;
  private maxSteps = 20;
  private debug = false;

  constructor(
    conf: Readonly<PromptConfig<T>> = {
      stopSequences: [],
    }
  ) {
    this.conf = conf;
    this.debug = conf.debug || false;
  }

  setMaxSteps(maxSteps: number) {
    this.maxSteps = maxSteps;
  }

  setDebug(debug: boolean) {
    this.debug = debug;
  }

  functionsSchema(): string {
    const functions = [...(this.conf.functions ?? [])];
    if (this.conf.responseConfig?.schema) {
      functions.push(finalResultFunc(this.conf.responseConfig?.schema));
    }
    return functionsToJSON(functions);
  }

  prompt(query: string, history: () => string): string {
    return `${query}\n${history()}\n`;
  }

  async generate(
    ai: AIService,
    query: string,
    { sessionId, memory, rateLimiter }: Options = {}
  ): Promise<AITextResponse<T>> {
    const wai = new AI(ai, this.conf.log, rateLimiter);
    const [, value] = await this._generate(
      wai,
      memory || new Memory(),
      query,
      sessionId
    );
    const traces = wai.getTraces();

    return {
      sessionId,
      prompt: query,
      traces,
      value: () => value,
    };
  }

  private async _generate(
    ai: Readonly<AI>,
    mem: AIMemory,
    query: string,
    sessionId?: string
  ): Promise<[GenerateTextResponse, T]> {
    try {
      return await this._generateHandler(ai, mem, query, sessionId);
    } catch (e: unknown) {
      const trace = ai.getTrace() as AIGenerateTextTrace;
      const err = e as Error;

      if (trace && trace.response) {
        trace.finalError = err.message;
      }
      throw new Error(err.message);
    } finally {
      if (this.debug) {
        ai.consoleLogTrace();
      }
      ai.logTrace();
    }
  }

  private async _generateHandler(
    ai: Readonly<AI>,
    mem: AIMemory,
    query: string,
    sessionId?: string
  ): Promise<[GenerateTextResponse, T]> {
    const { responseConfig, functions } = this.conf;
    const { keyValue, schema } = responseConfig || {};

    const extraOptions = {
      sessionId,
    };

    let res: GenerateTextResponse;
    let value: string;

    if (functions && functions?.length > 0) {
      [res, value] = await this._generateWithFunctions(
        ai,
        mem,
        query,
        extraOptions
      );
    } else {
      [res, value] = await this._generateDefault(ai, mem, query, extraOptions);
    }

    const retryCount = 3;

    for (let i = 0; i < retryCount; i++) {
      let fvalue: string | Map<string, string[]> | T;

      try {
        if (keyValue) {
          fvalue = stringToMap(value);
        } else if (schema) {
          fvalue = stringToObject<T>(value, schema);
        } else {
          fvalue = value;
        }
        return [res, fvalue] as [GenerateTextResponse, T];
      } catch (e: unknown) {
        const error = e as Error;
        const trace = ai.getTrace() as AIGenerateTextTrace;
        if (trace && trace.response) {
          trace.response.parsingError = {
            error: error.message,
            data: value,
          };
        }

        if (i < retryCount - 1) {
          continue;
        }

        const { fixedValue } = await this.fixSyntax(
          ai,
          mem,
          error,
          value,
          extraOptions
        );
        value = fixedValue;
      }
    }

    throw { message: `Unable to fix result syntax` };
  }

  private async _generateWithFunctions(
    ai: Readonly<AI>,
    mem: AIMemory,
    query: string,
    { sessionId }: Readonly<GenerateTextExtraOptions>
  ): Promise<[GenerateTextResponse, string]> {
    const conf = {
      ...this.conf,
      stopSequences: [...this.conf.stopSequences, 'Result:'],
    };

    const h = () => mem.history(sessionId);
    const functions = conf.functions ?? [];

    if (conf.responseConfig?.schema) {
      functions.push(finalResultFunc(conf.responseConfig.schema));
    }

    let previousValue;

    for (let i = 0; i < this.maxSteps; i++) {
      const p = this.prompt(query, h);
      const res = await ai.generate(p, conf, sessionId);
      const value = res.results.at(0)?.text?.trim() ?? '';

      if (previousValue && value === previousValue) {
        throw { message: 'Duplicate response received' };
      }

      if (value.length === 0) {
        throw { message: 'Empty response received' };
      }

      const funcExec = await processFunction(value, functions, ai, sessionId);

      const mval = ['\n', value, '\nResult: ', funcExec.result];
      mem.add(mval.join(''), sessionId);

      const trace = ai.getTrace() as AIGenerateTextTrace;
      if (trace && trace.response) {
        trace.response.functions = [
          ...(trace.response.functions ?? []),
          funcExec,
        ];
        trace.response.embedModelUsage = res.embedModelUsage;
      }

      if (funcExec.name.localeCompare('finalResult') === 0) {
        return [res, funcExec.result ?? ''];
      }
      previousValue = value;
    }

    throw { message: `max ${this.maxSteps} steps allowed` };
  }

  private async _generateDefault(
    ai: Readonly<AI>,
    mem: AIMemory,
    query: string,
    { sessionId }: Readonly<GenerateTextExtraOptions>
  ): Promise<[GenerateTextResponse, string]> {
    const h = () => mem.history(sessionId);
    const p = this.prompt(query, h);
    const res = await ai.generate(p, this.conf, sessionId);
    const value = res.results.at(0)?.text?.trim() ?? '';

    if (value.length === 0) {
      throw { message: 'Empty response received' };
    }

    const mval = [
      this.conf.queryPrefix,
      query,
      this.conf.responsePrefix,
      value,
    ];
    mem.add(mval.join(''), sessionId);
    return [res, value];
  }

  private async fixSyntax(
    ai: Readonly<AI>,
    mem: AIMemory,
    error: Readonly<Error>,
    value: string,
    { sessionId }: Readonly<GenerateTextExtraOptions>
  ): Promise<{ fixedValue: string }> {
    const p = `${mem.history()}\nSyntax Error: ${error.message}\n${value}`;
    const res = await ai.generate(p, this.conf, sessionId);
    const fixedValue = res.results.at(0)?.text?.trim() ?? '';

    if (fixedValue.length === 0) {
      throw { message: 'Empty response received' };
    }

    return { fixedValue };
  }
}

const stringToMap = (text: string): Map<string, string[]> => {
  const vm = new Map<string, string[]>();
  const re = /([a-zA-Z ]+):\s{0,}\n?(((?!N\/A).)+)$/gm;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
    vm.set(m[1], m[2].split(','));
  }
  if (vm.size === 0) {
    throw { message: 'Expected format is a list of key: value' };
  }
  return vm;
};
