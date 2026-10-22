import { describe, expect, it } from 'vitest';
import { trafficLimitInput, trafficLimitProblem } from '@/contours/users/lib/userForm';

describe('A-142: лимит 0 не становится безлимитом', () => {
  it('0 называется ошибкой поля, пустое и целое от 1 проходят', () => {
    expect(trafficLimitProblem(0)).toBe('zero');
    expect(trafficLimitProblem('')).toBeNull();
    expect(trafficLimitProblem(1)).toBeNull();
    expect(trafficLimitProblem(500)).toBeNull();
  });

  it('пустое поле уходит null (без лимита), число уходит как есть', () => {
    expect(trafficLimitInput('')).toBeNull();
    expect(trafficLimitInput(50)).toBe(50);
  });
});
