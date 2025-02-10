import type {
  AxAIModelList,
  AxAIService,
  AxFunction,
  AxFunctionJSONSchema,
} from '../ai/types.js'
import { AxGen, type AxGenOptions } from '../dsp/generate.js'
import {
  type AxGenIn,
  type AxGenOut,
  type AxGenStreamingOut,
  type AxProgramDemos,
  type AxProgramExamples,
  type AxProgramForwardOptions,
  type AxProgramStreamingForwardOptions,
  AxProgramWithSignature,
  type AxTunable,
  type AxUsable,
} from '../dsp/program.js'
import { AxSignature } from '../dsp/sig.js'

/**
 * Interface for agents that can be used as child agents.
 * Provides methods to get the agent's function definition and features.
 */
export interface AxAgentic extends AxTunable, AxUsable {
  getFunction(): AxFunction
  getFeatures(): AxAgentFeatures
}

export type AxAgentOptions = Omit<AxGenOptions, 'functions'> & {
  disableSmartModelRouting?: boolean
  /** List of field names that should not be automatically passed from parent to child agents */
  excludeFieldsFromPassthrough?: string[]
}

export interface AxAgentFeatures {
  /** Whether this agent can use smart model routing (requires an AI service) */
  canConfigureSmartModelRouting: boolean
  /** List of fields that this agent excludes from parent->child value passing */
  excludeFieldsFromPassthrough: string[]
}

/**
 * Processes a child agent's function, applying model routing and input injection as needed.
 * Handles both the schema modifications and function wrapping.
 */
function processChildAgentFunction<IN extends AxGenIn>(
  childFunction: Readonly<AxFunction>,
  parentValues: IN,
  parentInputKeys: string[],
  modelList: AxAIModelList | undefined,
  options: Readonly<{
    debug: boolean
    disableSmartModelRouting: boolean
    excludeFieldsFromPassthrough: string[]
    canConfigureSmartModelRouting: boolean
  }>
): AxFunction {
  let processedFunction = { ...childFunction }

  // Process input field injection
  if (processedFunction.parameters) {
    const childKeys = processedFunction.parameters.properties
      ? Object.keys(processedFunction.parameters.properties)
      : []

    // Find common keys between parent and child, excluding 'model' and specified exclusions
    const commonKeys = parentInputKeys
      .filter((key) => childKeys.includes(key))
      .filter((key) => key !== 'model')
    const injectionKeys = commonKeys.filter(
      (key) => !options.excludeFieldsFromPassthrough.includes(key)
    )

    if (injectionKeys.length > 0) {
      // Remove injected fields from child schema
      processedFunction.parameters = removePropertiesFromSchema(
        processedFunction.parameters,
        injectionKeys
      )

      // Wrap function to inject parent values
      const originalFunc = processedFunction.func
      // add debug logging if enabled
      processedFunction.func = (childArgs, funcOptions) => {
        const updatedChildArgs = {
          ...childArgs,
          ...pick(parentValues, injectionKeys as (keyof IN)[]),
        }
        if (options.debug && injectionKeys.length > 0) {
          process.stdout.write(
            `Function Params: ${JSON.stringify(updatedChildArgs, null, 2)}`
          )
        }

        return originalFunc(updatedChildArgs, funcOptions)
      }
    }

    return processedFunction
  }

  // Apply smart model routing if enabled
  if (
    modelList &&
    !options.disableSmartModelRouting &&
    options.canConfigureSmartModelRouting
  ) {
    processedFunction.parameters = addModelParameter(
      processedFunction.parameters,
      modelList
    )
  }

  return processedFunction
}

/**
 * An AI agent that can process inputs using an AI service and coordinate with child agents.
 * Supports features like smart model routing and automatic input field passing to child agents.
 */
export class AxAgent<IN extends AxGenIn, OUT extends AxGenOut = AxGenOut>
  implements AxAgentic
{
  private ai?: AxAIService
  private signature: AxSignature
  private program: AxProgramWithSignature<IN, OUT>
  private functions?: AxFunction[]
  private agents?: AxAgentic[]
  private disableSmartModelRouting?: boolean
  private excludeFieldsFromPassthrough: string[]

  private name: string
  private description: string
  private subAgentList?: string
  private func: AxFunction

  constructor(
    {
      ai,
      name,
      description,
      signature,
      agents,
      functions,
    }: Readonly<{
      ai?: Readonly<AxAIService>
      name: string
      description: string
      signature: AxSignature | string
      agents?: AxAgentic[]
      functions?: AxFunction[]
    }>,
    options?: Readonly<AxAgentOptions>
  ) {
    this.ai = ai
    this.agents = agents
    this.functions = functions
    this.disableSmartModelRouting = options?.disableSmartModelRouting
    this.excludeFieldsFromPassthrough =
      options?.excludeFieldsFromPassthrough ?? []

    this.signature = new AxSignature(signature)
    this.signature.setDescription(description)

    if (!name || name.length < 5) {
      throw new Error(
        `Agent name must be at least 10 characters (more descriptive): ${name}`
      )
    }

    if (!description || description.length < 20) {
      throw new Error(
        `Agent description must be at least 20 characters (explain in detail what the agent does): ${description}`
      )
    }

    this.program = new AxGen<IN, OUT>(this.signature, options)

    for (const agent of agents ?? []) {
      this.program.register(agent)
    }

    this.name = name
    this.description = description
    this.subAgentList = agents?.map((a) => a.getFunction().name).join(', ')

    this.func = {
      name: toCamelCase(this.name),
      description: this.description,
      parameters: this.signature.toJSONSchema(),
      func: () => this.forward,
    }

    const mm = ai?.getModelList()
    // Only add model parameter if smart routing is enabled and model list exists
    if (mm && !this.disableSmartModelRouting) {
      this.func.parameters = addModelParameter(this.func.parameters, mm)
    }
  }

  public setExamples(examples: Readonly<AxProgramExamples>) {
    this.program.setExamples(examples)
  }

  public setId(id: string) {
    this.program.setId(id)
  }

  public setParentId(parentId: string) {
    this.program.setParentId(parentId)
  }

  public getTraces() {
    return this.program.getTraces()
  }

  public setDemos(demos: readonly AxProgramDemos[]) {
    this.program.setDemos(demos)
  }

  public getUsage() {
    return this.program.getUsage()
  }

  public resetUsage() {
    this.program.resetUsage()
  }

  public getFunction(): AxFunction {
    const boundFunc = this.forward.bind(this)

    // Create a wrapper function that excludes the 'ai' parameter
    const wrappedFunc = (
      valuesAndModel: IN & { model: string },
      options?: Readonly<AxProgramForwardOptions>
    ) => {
      const { model, ...values } = valuesAndModel
      const ai = this.ai ?? options?.ai
      if (!ai) {
        throw new Error('AI service is required to run the agent')
      }
      return boundFunc(ai, values as unknown as IN, { ...options, model })
    }

    return {
      ...this.func,
      func: wrappedFunc,
    }
  }

  public getFeatures(): AxAgentFeatures {
    return {
      canConfigureSmartModelRouting: this.ai === undefined,
      excludeFieldsFromPassthrough: this.excludeFieldsFromPassthrough,
    }
  }

  /**
   * Initializes the agent's execution context, processing child agents and their functions.
   */
  private init(
    parentAi: Readonly<AxAIService>,
    values: IN,
    options: Readonly<AxProgramForwardOptions> | undefined
  ) {
    const ai = this.ai ?? parentAi
    const mm = ai?.getModelList()

    // Get parent's input schema and keys
    const parentSchema = this.signature.getInputFields()
    const parentKeys = parentSchema.map((p) => p.name)

    // Process each child agent's function
    const agentFuncs = this.agents?.map((agent) => {
      const f = agent.getFeatures()

      const processOptions = {
        debug: ai?.getOptions()?.debug ?? false,
        disableSmartModelRouting: !!this.disableSmartModelRouting,
        excludeFieldsFromPassthrough: f.excludeFieldsFromPassthrough,
        canConfigureSmartModelRouting: f.canConfigureSmartModelRouting,
      }

      return processChildAgentFunction(
        agent.getFunction(),
        values,
        parentKeys,
        mm,
        processOptions
      )
    })

    // Combine all functions
    const functions: AxFunction[] = [
      ...(options?.functions ?? this.functions ?? []),
      ...(agentFuncs ?? []),
    ]

    return { ai, functions }
  }

  public async forward(
    parentAi: Readonly<AxAIService>,
    values: IN,
    options?: Readonly<AxProgramForwardOptions>
  ): Promise<OUT> {
    const { ai, functions } = this.init(parentAi, values, options)
    return await this.program.forward(ai, values, { ...options, functions })
  }

  public async *streamingForward(
    parentAi: Readonly<AxAIService>,
    values: IN,
    options?: Readonly<AxProgramStreamingForwardOptions>
  ): AxGenStreamingOut<OUT> {
    const { ai, functions } = this.init(parentAi, values, options)
    return yield* this.program.streamingForward(ai, values, {
      ...options,
      functions,
    })
  }

  /**
   * Updates the agent's description.
   * This updates both the stored description and the function's description.
   *
   * @param description - New description for the agent (must be at least 20 characters)
   * @throws Error if description is too short
   */
  public setDescription(description: string): void {
    if (!description || description.length < 20) {
      throw new Error(
        'Agent description must be at least 20 characters (explain in detail what the agent does)'
      )
    }

    this.description = description
    this.signature.setDescription(description)
    this.func.description = description
  }
}

function toCamelCase(inputString: string): string {
  // Split the string by any non-alphanumeric character (including underscores, spaces, hyphens)
  const words = inputString.split(/[^a-zA-Z0-9]/)

  // Map through each word, capitalize the first letter of each word except the first word
  const camelCaseString = words
    .map((word, index) => {
      // Lowercase the word to handle cases like uppercase letters in input
      const lowerWord = word.toLowerCase()

      // Capitalize the first letter of each word except the first one
      if (index > 0 && lowerWord && lowerWord[0]) {
        return lowerWord[0].toUpperCase() + lowerWord.slice(1)
      }

      return lowerWord
    })
    .join('')

  return camelCaseString
}

/**
 * Adds a required model parameter to a JSON Schema definition based on provided model mappings.
 * The model parameter will be an enum with values from the model map keys.
 *
 * @param parameters - The original JSON Schema parameters definition (optional)
 * @param models - Array of model mappings containing keys, model names and descriptions
 * @returns Updated JSON Schema with added model parameter
 */
export function addModelParameter(
  parameters: AxFunctionJSONSchema | undefined,
  models: AxAIModelList
): AxFunctionJSONSchema {
  // If parameters is undefined, create a base schema
  const baseSchema: AxFunctionJSONSchema = parameters
    ? structuredClone(parameters)
    : {
        type: 'object',
        properties: {},
        required: [],
      }

  // Check if model parameter already exists
  if (baseSchema.properties?.model) {
    return baseSchema
  }

  // Create the model property schema
  const modelProperty: AxFunctionJSONSchema & {
    enum: string[]
    description: string
  } = {
    type: 'string',
    enum: models.map((m) => m.key),
    description: `The AI model to use for this function call. Available options: ${models
      .map((m) => `\`${m.key}\` ${m.description}`)
      .join(', ')}`,
  }

  // Create new properties object with model parameter
  const newProperties = {
    ...(baseSchema.properties ?? {}),
    model: modelProperty,
  }

  // Add model to required fields
  const newRequired = [...(baseSchema.required ?? []), 'model']

  // Return updated schema
  return {
    ...baseSchema,
    properties: newProperties,
    required: newRequired,
  }
}

// ----------------------------------------------------------------------
// New helper: removePropertiesFromSchema
//    Clones a JSON schema and removes properties and required fields matching the provided keys.
// ----------------------------------------------------------------------
function removePropertiesFromSchema(
  schema: Readonly<AxFunctionJSONSchema>,
  keys: string[]
): AxFunctionJSONSchema {
  const newSchema = structuredClone(schema)
  if (newSchema.properties) {
    for (const key of keys) {
      delete newSchema.properties[key]
    }
  }
  if (Array.isArray(newSchema.required)) {
    const filteredRequired = newSchema.required.filter(
      (r: string) => !keys.includes(r)
    )
    Object.defineProperty(newSchema, 'required', {
      value: filteredRequired,
      writable: true,
      configurable: true,
    })
  }
  return newSchema
}

// ----------------------------------------------------------------------
// New helper: pick
//    Returns an object composed of the picked object properties.
// ----------------------------------------------------------------------
function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key]
    }
  }
  return result
}
