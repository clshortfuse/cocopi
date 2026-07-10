// https://platform.openai.com/docs/api-reference/responses/create

/** @typedef {string | number | boolean | null | object} CodexJsonValue */

/**
 * OpenAI Responses API create-body shape, narrowed to the fields this extension
 * currently builds or expects to bridge first.
 *
 * @see https://platform.openai.com/docs/api-reference/responses/create
 * @see https://github.com/openai/codex/blob/88f300d74d93bfee6750100ee5d3056672cad3ad/codex-rs/codex-api/src/common.rs
 * @typedef {object} CodexResponseCreateRequest
 * @property {string} model
 * @property {CodexResponseInput} [input]
 * @property {string} [instructions]
 * @property {boolean} [stream]
 * @property {boolean} [store]
 * @property {CodexResponseInclude[]} [include]
 * @property {CodexTool[]} [tools]
 * @property {CodexToolChoice} [tool_choice]
 * @property {boolean} [parallel_tool_calls]
 * @property {CodexReasoning | null} [reasoning]
 * @property {CodexResponseTextConfig} [text]
 * @property {CodexServiceTier} [service_tier]
 * @property {string} [previous_response_id]
 * @property {string} [prompt_cache_key]
 * @property {Record<string, string>} [metadata]
 * @property {Record<string, CodexJsonValue>} [client_metadata]
 */

/** @typedef {string | CodexResponseInputItem[]} CodexResponseInput */

/**
 * @typedef {object} CodexResponseInputMessage
 * @property {'message'} [type]
 * @property {'system' | 'developer' | 'user' | 'assistant'} role
 * @property {string | CodexContentItem[]} content
 * @property {string | null} [phase]
 */

/**
 * Function-call item replayed from previous model output.
 *
 * @see https://platform.openai.com/docs/guides/function-calling
 * @typedef {object} CodexResponseFunctionCallInputItem
 * @property {'function_call'} type
 * @property {string} call_id
 * @property {string} name
 * @property {string} arguments
 */

/**
 * Function-call output item supplied after the host invokes a tool.
 *
 * @see https://platform.openai.com/docs/guides/function-calling
 * @typedef {object} CodexResponseFunctionCallOutputInputItem
 * @property {'function_call_output'} type
 * @property {string} call_id
 * @property {string} output
 */

/**
 * Encrypted reasoning item replayed from previous model output for stateless
 * Responses requests.
 *
 * @see https://platform.openai.com/docs/guides/reasoning
 * @typedef {object} CodexResponseReasoningInputItem
 * @property {'reasoning'} type
 * @property {string} [id]
 * @property {CodexJsonValue[]} [summary]
 * @property {string | null} [encrypted_content]
 * @property {string | null} [phase]
 */

/** @typedef {CodexResponseInputMessage | CodexResponseReasoningInputItem | CodexResponseFunctionCallInputItem | CodexResponseFunctionCallOutputInputItem | Record<string, CodexJsonValue>} CodexResponseInputItem */

/**
 * @typedef {object} CodexInputTextContent
 * @property {'input_text'} type
 * @property {string} text
 */

/**
 * @typedef {object} CodexInputImageContent
 * @property {'input_image'} type
 * @property {string} image_url
 */

/**
 * @typedef {object} CodexOutputTextContent
 * @property {'output_text'} type
 * @property {string} text
 */

/** @typedef {CodexInputTextContent | CodexInputImageContent | CodexOutputTextContent | Record<string, CodexJsonValue>} CodexContentItem */

/** @typedef {'code_interpreter_call.outputs' | 'computer_call_output.output.image_url' | 'file_search_call.results' | 'message.input_image.image_url' | 'message.output_text.logprobs' | 'reasoning.encrypted_content'} CodexResponseInclude */

/** @typedef {'priority' | 'flex'} CodexServiceTier */

/** @typedef {string} CodexReasoningEffort */

/** @typedef {'auto' | 'concise' | 'detailed' | 'none'} CodexReasoningSummary */

/** @typedef {'disabled' | 'v1' | 'v2'} CodexMultiAgentVersion */

/** @typedef {'direct' | 'code_mode' | 'code_mode_only'} CodexToolMode */

/** @typedef {'used' | 'skipped'} CodexPreviousResponseDecisionAction */

/** @typedef {'matched-prefix' | 'no-prior-request' | 'no-prior-response-id' | 'explicit-previous-response-id' | 'non-array-input' | 'request-state-changed' | 'input-shorter-than-baseline' | 'input-prefix-mismatch'} CodexPreviousResponseDecisionReason */

/**
 * @typedef {object} CodexPreviousResponseDecision
 * @property {CodexPreviousResponseDecisionAction} action
 * @property {CodexPreviousResponseDecisionReason} reason
 * @property {number | undefined} [inputItems]
 * @property {number | undefined} [baselineItems]
 * @property {number | undefined} [deltaItems]
 * @property {string[] | undefined} [requestStateChanges]
 * @property {number | undefined} [inputPrefixMatchingItems]
 * @property {number | undefined} [inputPrefixMismatchIndex]
 * @property {string | undefined} [inputPrefixExpected]
 * @property {string | undefined} [inputPrefixActual]
 * @property {string | undefined} [inputPrefixExpectedDigest]
 * @property {string | undefined} [inputPrefixActualDigest]
 */

/** @typedef {'auto' | 'none' | 'required' | Record<string, CodexJsonValue>} CodexToolChoice */

/**
 * @typedef {object} CodexFunctionTool
 * @property {'function'} type
 * @property {string} name
 * @property {string} [description]
 * @property {Record<string, CodexJsonValue>} parameters
 * @property {boolean} [strict]
 */

/** @typedef {CodexFunctionTool | Record<string, CodexJsonValue>} CodexTool */

/**
 * @typedef {object} CodexReasoning
 * @property {CodexReasoningEffort} [effort]
 * @property {CodexReasoningSummary | null} [summary]
 * @property {CodexReasoningSummary | null} [generate_summary]
 */

/**
 * @typedef {object} CodexResponseTextConfig
 * @property {{ type: 'text' } | Record<string, CodexJsonValue>} [format]
 * @property {'low' | 'medium' | 'high'} [verbosity]
 */

/**
 * Minimal response object shape used by smoke tests. The full official response
 * has many more fields; keep this permissive while we build event translation.
 *
 * @see https://platform.openai.com/docs/api-reference/responses/create
 * @typedef {object} CodexResponse
 * @property {string} [id]
 * @property {'response'} [object]
 * @property {string} [model]
 * @property {'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'incomplete'} [status]
 * @property {string} [output_text]
 * @property {CodexJsonValue[]} [output]
 * @property {Record<string, CodexJsonValue> | null} [error]
 */

/**
 * Streaming event emitted when output text arrives incrementally.
 *
 * @see https://platform.openai.com/docs/api-reference/responses/streaming
 * @typedef {object} CodexResponseOutputTextDeltaEvent
 * @property {'response.output_text.delta'} type
 * @property {string} delta
 * @property {string} [item_id]
 * @property {number} [output_index]
 * @property {number} [content_index]
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when an output item begins.
 *
 * @typedef {object} CodexResponseOutputItemAddedEvent
 * @property {'response.output_item.added'} type
 * @property {number} output_index
 * @property {CodexResponseFunctionCallOutputItem | CodexResponseReasoningOutputItem | Record<string, CodexJsonValue>} item
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when the response completes.
 *
 * @typedef {object} CodexResponseCompletedEvent
 * @property {'response.completed'} type
 * @property {CodexResponse} response
 */

/**
 * Streaming event emitted when the response fails.
 *
 * @typedef {object} CodexResponseFailedEvent
 * @property {'response.failed'} type
 * @property {CodexResponse} [response]
 * @property {Record<string, CodexJsonValue> | null} [error]
 */

/**
 * Streaming event emitted when the response is incomplete.
 *
 * @typedef {object} CodexResponseIncompleteEvent
 * @property {'response.incomplete'} type
 * @property {CodexResponse} [response]
 */

/**
 * Streaming event emitted while function-call arguments arrive incrementally.
 *
 * The final `response.function_call_arguments.done` or matching
 * `response.output_item.done` event carries the complete JSON arguments.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseFunctionCallArgumentsDeltaEvent
 * @property {'response.function_call_arguments.delta'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {string} delta
 * @property {number} [sequence_number]
 * @property {string} [obfuscation]
 */

/**
 * Streaming event emitted when a readable reasoning summary part begins.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseReasoningSummaryPartAddedEvent
 * @property {'response.reasoning_summary_part.added'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {number} summary_index
 * @property {{ type: 'summary_text', text: string } | Record<string, CodexJsonValue>} part
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when a readable reasoning summary receives text.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseReasoningSummaryTextDeltaEvent
 * @property {'response.reasoning_summary_text.delta'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {number} summary_index
 * @property {string} delta
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when a readable reasoning summary text completes.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseReasoningSummaryTextDoneEvent
 * @property {'response.reasoning_summary_text.done'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {number} summary_index
 * @property {string} text
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when reasoning text arrives incrementally.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseReasoningTextDeltaEvent
 * @property {'response.reasoning_text.delta'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {number} content_index
 * @property {string} delta
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when reasoning text completes.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseReasoningTextDoneEvent
 * @property {'response.reasoning_text.done'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {number} content_index
 * @property {string} text
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when a readable reasoning summary part completes.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseReasoningSummaryPartDoneEvent
 * @property {'response.reasoning_summary_part.done'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {number} summary_index
 * @property {{ type: 'summary_text', text: string } | Record<string, CodexJsonValue>} part
 * @property {number} [sequence_number]
 */

/**
 * Streaming event emitted when function-call arguments are finalized.
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 * @typedef {object} CodexResponseFunctionCallArgumentsDoneEvent
 * @property {'response.function_call_arguments.done'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {string} name
 * @property {string} arguments
 * @property {string} [call_id]
 */

/**
 * Function-call output item from a completed output-item event.
 *
 * @typedef {object} CodexResponseFunctionCallOutputItem
 * @property {'function_call'} type
 * @property {string} [id]
 * @property {string} [call_id]
 * @property {string} name
 * @property {string} arguments
 */

/**
 * Reasoning output item from a completed output-item event.
 *
 * @typedef {object} CodexResponseReasoningOutputItem
 * @property {'reasoning'} type
 * @property {string} [id]
 * @property {CodexJsonValue[]} [summary]
 * @property {string | null} [encrypted_content]
 * @property {string | null} [phase]
 */

/**
 * Streaming event emitted when an output item is finalized.
 *
 * @typedef {object} CodexResponseOutputItemDoneEvent
 * @property {'response.output_item.done'} type
 * @property {string} item_id
 * @property {number} output_index
 * @property {CodexResponseFunctionCallOutputItem | CodexResponseReasoningOutputItem | Record<string, CodexJsonValue>} item
 */

/** @typedef {CodexResponseOutputTextDeltaEvent | CodexResponseOutputItemAddedEvent | CodexResponseReasoningSummaryPartAddedEvent | CodexResponseReasoningSummaryTextDeltaEvent | CodexResponseReasoningSummaryTextDoneEvent | CodexResponseReasoningTextDeltaEvent | CodexResponseReasoningTextDoneEvent | CodexResponseReasoningSummaryPartDoneEvent | CodexResponseCompletedEvent | CodexResponseFailedEvent | CodexResponseIncompleteEvent | CodexResponseFunctionCallArgumentsDeltaEvent | CodexResponseFunctionCallArgumentsDoneEvent | CodexResponseOutputItemDoneEvent} CodexResponseStreamEvent */

/**
 * Codex backend model-catalog response. Codex Rust calls this `ModelsResponse`
 * and expects a `models` array; OpenAI-compatible model endpoints can also use
 * a `data` array.
 *
 * @see https://github.com/openai/codex/blob/88f300d74d93bfee6750100ee5d3056672cad3ad/codex-rs/protocol/src/openai_models.rs
 * @see https://github.com/openai/codex/blob/88f300d74d93bfee6750100ee5d3056672cad3ad/codex-rs/codex-api/src/endpoint/models.rs
 * @typedef {object} CodexModelsResponse
 * @property {CodexModelInfo[]} [models]
 * @property {CodexModelInfo[]} [data]
 */

/**
 * @typedef {object} CodexModelInfo
 * @property {string} [slug]
 * @property {string} [id]
 * @property {string} [display_name]
 * @property {string} [displayName]
 * @property {boolean} [supported_in_api]
 * @property {number} [priority]
 * @property {string} [description]
 * @property {number} [context_window]
 * @property {number} [max_context_window]
 * @property {number | null} [auto_compact_token_limit]
 * @property {string[]} [additional_speed_tiers]
 * @property {CodexModelServiceTier[]} [service_tiers]
 * @property {string} [default_service_tier]
 * @property {CodexReasoningEffort} [default_reasoning_level]
 * @property {CodexReasoningEffort} [defaultReasoningEffort]
 * @property {CodexReasoningEffortPreset[]} [supported_reasoning_levels]
 * @property {CodexReasoningEffortPreset[]} [supportedReasoningEfforts]
 * @property {boolean} [supports_reasoning_summaries]
 * @property {CodexReasoningSummary} [default_reasoning_summary]
 * @property {CodexMultiAgentVersion} [multi_agent_version]
 * @property {CodexToolMode} [tool_mode]
 * @property {boolean} [supports_parallel_tool_calls]
 * @property {string[]} [available_in_plans]
 * @property {boolean} [supports_images]
 * @property {boolean} [supports_image_input]
 * @property {boolean} [supports_vision]
 * @property {Record<string, CodexJsonValue>} [capabilities]
 */

/**
 * @typedef {object} CodexModelServiceTier
 * @property {string} id
 * @property {string} [name]
 * @property {string} [description]
 */

/**
 * @typedef {object} CodexReasoningEffortPreset
 * @property {CodexReasoningEffort} [effort]
 * @property {CodexReasoningEffort} [reasoningEffort]
 * @property {string} [description]
 */

/**
 * @typedef {object} CodexModelSummary
 * @property {string} id
 * @property {string} displayName
 * @property {string} [description]
 * @property {boolean} [supportedInApi]
 * @property {number} [priority]
 * @property {number} [contextWindow]
 * @property {number} [maxContextWindow]
 * @property {number | null} [autoCompactTokenLimit]
 * @property {string[]} [additionalSpeedTiers]
 * @property {CodexModelServiceTier[]} [serviceTiers]
 * @property {string} [defaultServiceTier]
 * @property {CodexReasoningEffort} [defaultReasoningLevel]
 * @property {{ effort: CodexReasoningEffort, description?: string }[]} [supportedReasoningLevels]
 * @property {boolean} [supportsReasoningSummaries]
 * @property {CodexReasoningSummary} [defaultReasoningSummary]
 * @property {CodexMultiAgentVersion} [multiAgentVersion]
 * @property {CodexToolMode} [toolMode]
 * @property {boolean} [supportsParallelToolCalls]
 * @property {string[]} [availableInPlans]
 * @property {boolean} [imageInput]
 */

/**
 * Headers added by Codex first-party auth providers.
 *
 * @see https://github.com/openai/codex/blob/88f300d74d93bfee6750100ee5d3056672cad3ad/codex-rs/model-provider/src/bearer_auth_provider.rs
 * @typedef {object} CodexAuthHeaderOptions
 * @property {string} accessToken
 * @property {string} [chatgptAccountId]
 * @property {boolean} [fedramp]
 * @property {string} [originator]
 */

export {};
