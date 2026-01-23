import { MockLanguageModelV3 } from "ai/test";
import { MagmaAgent } from "../../src/index";

export function createMockAgent(
	mockResponses: ConstructorParameters<typeof MockLanguageModelV3>[0] = {}
) {
	const mockModel = new MockLanguageModelV3(mockResponses);

	const mockAgent = new MagmaAgent({
		llmConfig: {
			model: mockModel
		},
		state: {}
	});

	return mockAgent;
}
