export const mockScenarios = ["normal", "database_failure", "external_api_failure"] as const;
export type MockScenario = (typeof mockScenarios)[number];
let activeScenario: MockScenario = "normal";
export function getMockScenario(): MockScenario { return activeScenario; }
export function setMockScenario(scenario: MockScenario): MockScenario { activeScenario = scenario; return activeScenario; }
