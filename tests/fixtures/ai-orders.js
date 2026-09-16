export function createOrdersFixture() {
  return [
    ['单价', '数量', '销售额'],
    [10, 2, null],
    [5, 3, null],
    [8, 4, null]
  ];
}

export function createOrdersWithExistingTargetFixture() {
  const data = createOrdersFixture();
  data[1][2] = 999;
  return data;
}

export function createOrdersWithMissingPriceFixture() {
  const data = createOrdersFixture();
  data[1][0] = null;
  return data;
}

export function createOrdersWithStyledTargetFixture() {
  const data = createOrdersFixture();

  for (let r = 1; r < data.length; r++) {
    data[r][2] = {
      v: null,
      s: {
        fmt: 'comma',
        decimals: 2,
        border: {
          bottom: { color: '#333333', style: 'solid' }
        }
      }
    };
  }

  return data;
}
