import { DEFAULT_SETTINGS } from '../../../src/settings/defaults';

describe('Settings defaults', () => {
  test('viewsButtonAlignment defaults to right', () => {
    expect(DEFAULT_SETTINGS.viewsButtonAlignment).toBe('right');
  });

  test('status defaults match Hermes Kanban states', () => {
    expect(DEFAULT_SETTINGS.defaultTaskStatus).toBe('triage');
    expect(DEFAULT_SETTINGS.customStatuses.map((status) => status.value)).toEqual([
      'triage',
      'todo',
      'ready',
      'running',
      'blocked',
      'done',
      'archived',
    ]);
    expect(DEFAULT_SETTINGS.customStatuses.find((status) => status.value === 'done')?.isCompleted).toBe(true);
    expect(DEFAULT_SETTINGS.customStatuses.find((status) => status.value === 'archived')?.isCompleted).toBe(true);
    expect(DEFAULT_SETTINGS.customStatuses.find((status) => status.value === 'archived')?.excludeFromCycle).toBe(true);
  });
});
