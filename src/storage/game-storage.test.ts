import { describe, it, expect } from 'vitest';
import { generateSaveId, generateScenarioSeed } from './opfs';

describe('Game Storage Utilities', () => {
  it('should generate a valid save ID', () => {
    const saveId = generateSaveId();
    expect(saveId).toMatch(/^save_\d+_[a-z0-9]+$/);
  });

  it('should generate a valid scenario seed', () => {
    const seed = generateScenarioSeed();
    expect(seed).toHaveLength(32);
    expect(seed).toMatch(/^[0-9a-f]+$/);
  });
});
