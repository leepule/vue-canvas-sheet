/**
 * 扩展 Playwright test fixture
 *
 * 为每个测试提供：
 *   - tablePage: 预初始化的 TablePage 页面对象
 *   - 常用数据集
 */
import { test as base, expect } from '@playwright/test';
import { TablePage } from '../page-objects/table-page';
import {
  SMALL_DATASET,
  FORMULA_DATASET,
  MEDIUM_DATASET,
  LARGE_DATASET,
} from './test-data';

type E2EFixtures = {
  /** 页面对象 — 已导航到测试页面并等待就绪 */
  tablePage: TablePage;
  /** 10行×5列 小型数据集 */
  smallData: any[][];
  /** 含公式的数据集 */
  formulaData: any[][];
  /** 200行×15列 中等数据集 */
  mediumData: any[][];
  /** 1000行×20列 大数据集 */
  largeData: any[][];
};

export const test = base.extend<E2EFixtures>({
  tablePage: async ({ page }, use) => {
    const tp = new TablePage(page);
    await tp.goto();
    await tp.waitForReady();
    try {
      await use(tp);
    } finally {
      await tp.dispose();
    }
  },

  smallData: async ({}, use) => {
    await use(SMALL_DATASET);
  },

  formulaData: async ({}, use) => {
    await use(FORMULA_DATASET);
  },

  mediumData: async ({}, use) => {
    await use(MEDIUM_DATASET);
  },

  largeData: async ({}, use) => {
    await use(LARGE_DATASET);
  },
});

export { expect };
