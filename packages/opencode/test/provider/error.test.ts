import { expect, test } from "bun:test"

import { ProviderError } from "../../src/provider/error"

test("parses nested Responses stream server_error as retryable", () => {
  const parsed = ProviderError.parseStreamError({
    type: "error",
    sequence_number: 3,
    error: {
      type: "server_error",
      code: "server_error",
      message: "An error occurred while processing your request. Request id req_test.",
    },
  })

  expect(parsed).toEqual({
    type: "api_error",
    message: "An error occurred while processing your request. Request id req_test.",
    isRetryable: true,
    responseBody:
      '{"type":"error","sequence_number":3,"error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. Request id req_test."}}',
  })
})

test("parses invalid_prompt stream errors as non-retryable", () => {
  const parsed = ProviderError.parseStreamError({
    type: "error",
    error: {
      code: "invalid_prompt",
      message: "Invalid prompt.",
    },
  })

  expect(parsed).toMatchObject({
    type: "api_error",
    message: "Invalid prompt.",
    isRetryable: false,
  })
})
