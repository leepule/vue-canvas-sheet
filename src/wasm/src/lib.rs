// Vue-Canvas-Sheet
// (c) 2026-present
// Released under the Apache License, Version 2.0.

use wasm_bindgen::prelude::*;
use js_sys::{Float64Array, SharedArrayBuffer, Array, Object, Reflect, Uint32Array};
use pest::Parser;
use pest_derive::Parser;

mod evaluator;
use std::collections::HashMap;
use crate::evaluator::{CalcValue, FunctionRegistry, AstNode};

#[derive(Parser)]
#[grammar = "formula.pest"]
struct FormulaParser;

#[wasm_bindgen]
pub struct FormulaEngine {
    registry: FunctionRegistry,
    shared_buffer: Option<Float64Array>,
    grid_rows: usize,
    grid_cols: usize,
    ast_cache: HashMap<String, AstNode>,
}

#[wasm_bindgen]
impl FormulaEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            registry: FunctionRegistry::new(),
            shared_buffer: None,
            grid_rows: 0,
            grid_cols: 0,
            ast_cache: HashMap::new(),
        }
    }

    pub fn init_shared_memory(&mut self, sab: SharedArrayBuffer, rows: usize, cols: usize) {
        self.shared_buffer = Some(Float64Array::new(&sab));
        self.grid_rows = rows;
        self.grid_cols = cols;
    }

    pub fn get_grid_rows(&self) -> usize {
        self.grid_rows
    }

    pub fn get_grid_cols(&self) -> usize {
        self.grid_cols
    }

    pub fn update_grid_rows(&mut self, rows: usize) {
        self.grid_rows = rows;
    }

    pub fn evaluate(&mut self, formula: &str) -> JsValue {
        self.evaluate_internal(formula).to_js_value()
    }

    fn evaluate_internal(&mut self, formula: &str) -> CalcValue {
        let ast = if let Some(cached) = self.ast_cache.get(formula) {
            cached.clone()
        } else {
            match FormulaParser::parse(Rule::formula, formula) {
                Ok(pairs) => {
                    match pairs.into_iter().next() {
                        Some(first_pair) => {
                            let ast = self.build_ast(first_pair);
                            self.ast_cache.insert(formula.to_string(), ast.clone());
                            ast
                        },
                        None => AstNode::String("#ERROR!".to_string()),
                    }
                },
                Err(_) => AstNode::String("#ERROR!".to_string()),
            }
        };

        self.eval_ast(&ast, (0, 0))
    }

    pub fn evaluate_group(&mut self, rows: Uint32Array, cols: Uint32Array, formula: &str, ids: Array) -> JsValue {
        let non_numeric = Object::new();
        let len = rows.length();
        let has_shared = self.shared_buffer.is_some();

        // 无共享内存时才收集 numeric_vals，有共享内存时直接写入（零拷贝）
        let mut numeric_vals = if has_shared { Vec::new() } else { Vec::with_capacity(len as usize) };

        // 循环外解析公式（5万次合并为1次）
        let ast = if let Some(cached) = self.ast_cache.get(formula) {
            cached.clone()
        } else {
            match FormulaParser::parse(Rule::formula, formula) {
                Ok(pairs) => {
                    match pairs.into_iter().next() {
                        Some(first_pair) => {
                            let ast = self.build_ast(first_pair);
                            self.ast_cache.insert(formula.to_string(), ast.clone());
                            ast
                        },
                        None => AstNode::String("#ERROR!".to_string()),
                    }
                },
                Err(_) => AstNode::String("#ERROR!".to_string()),
            }
        };

        for i in 0..len {
            let r = rows.get_index(i) as usize;
            let c = cols.get_index(i) as usize;

            let res = self.eval_ast(&ast, (r, c));

            match res {
                CalcValue::Number(n) => {
                    if let Some(ref buffer) = self.shared_buffer {
                        // 零拷贝：直接写入 SharedArrayBuffer
                        if r < self.grid_rows && c < self.grid_cols {
                            let idx = (r * self.grid_cols + c) as u32;
                            buffer.set_index(idx, n);
                        }
                    } else {
                        numeric_vals.push(n);
                    }
                },
                _ => {
                    if let Some(ref buffer) = self.shared_buffer {
                        if r < self.grid_rows && c < self.grid_cols {
                            let idx = (r * self.grid_cols + c) as u32;
                            buffer.set_index(idx, f64::NAN); // 写入 NaN 清除残余脏值
                        }
                    }
                    if !has_shared {
                        numeric_vals.push(f64::NAN); // 占位符
                    }
                    let cell_id = ids.get(i);
                    let _ = Reflect::set(&non_numeric, &cell_id, &res.to_js_value());
                }
            }
        }

        let output = Object::new();
        // 仅在无共享内存时返回 numeric_results（降级路径）
        if !has_shared {
            let _ = Reflect::set(&output, &"numeric_results".into(), &Float64Array::from(numeric_vals.as_slice()).into());
        }
        let _ = Reflect::set(&output, &"non_numeric_results".into(), &non_numeric.into());
        output.into()
    }

    /// 二元运算符优先级（数值越大优先级越高），与 Excel / JS 标准一致。
    fn op_precedence(op: &str) -> u8 {
        match op {
            "*" | "/" => 4,
            "+" | "-" => 3,
            "&" => 2,
            "=" | "<>" | "<" | ">" | "<=" | ">=" => 1,
            _ => 0,
        }
    }

    /// 用 Shunting-Yard（操作数栈 + 运算符栈）按优先级构建左结合 AST。
    /// `operands.len() == operators.len() + 1`。
    ///
    /// **无恐慌保证**：所有栈操作均使用 `unwrap_or_else`，
    /// 畸形输入（操作数/运算符数量失衡）安全降级为 `#ERROR!` 节点，不会 panic。
    fn build_with_precedence(operands: Vec<AstNode>, operators: Vec<String>) -> AstNode {
        // 防御：空操作数不应到达此处（语法保证），但即使发生也不 panic
        if operands.is_empty() {
            return AstNode::String("#ERROR!".to_string());
        }

        let mut out: Vec<AstNode> = Vec::new();
        let mut ops: Vec<String> = Vec::new();
        let mut operand_iter = operands.into_iter();
        out.push(operand_iter.next().unwrap_or_else(|| AstNode::String("#ERROR!".to_string())));

        // 归约闭包：从 out 栈弹出右/左操作数并构建 BinaryOp 节点。
        // 栈空时用 `#ERROR!` 占位，避免 panic 导致 WASM 实例挂死。
        let reduce = |out: &mut Vec<AstNode>, op: String| {
            let right = out.pop().unwrap_or_else(|| AstNode::String("#ERROR!".to_string()));
            let left = out.pop().unwrap_or_else(|| AstNode::String("#ERROR!".to_string()));
            out.push(AstNode::BinaryOp { left: Box::new(left), op, right: Box::new(right) });
        };

        for op in operators {
            let prec = Self::op_precedence(&op);
            // 左结合：栈顶优先级 >= 当前则先归约
            while let Some(top) = ops.last() {
                if Self::op_precedence(top) >= prec {
                    // 安全：while let Some 已保证栈非空
                    let top_op = ops.pop().unwrap();
                    reduce(&mut out, top_op);
                } else {
                    break;
                }
            }
            ops.push(op);
            // 防御：操作数不足时用 #ERROR! 填充，不 panic
            out.push(operand_iter.next().unwrap_or_else(|| AstNode::String("#ERROR!".to_string())));
        }
        while let Some(_top_op) = ops.pop() {
            reduce(&mut out, _top_op);
        }
        // 防御：最终结果栈空时返回 #ERROR!
        out.pop().unwrap_or_else(|| AstNode::String("#ERROR!".to_string()))
    }

    fn build_ast(&self, pair: pest::iterators::Pair<Rule>) -> AstNode {
        match pair.as_rule() {
            Rule::formula => {
                // 防御：语法规则保证 formula 有子节点，但不 panic
                match pair.into_inner().next() {
                    Some(child) => self.build_ast(child),
                    None => AstNode::String("#ERROR!".to_string()),
                }
            },
            Rule::expr => {
                // 收集扁平的 term/op 序列后，按标准运算符优先级构建 AST，
                // 而非简单的从左到右折叠（保证 =1+2*3 得 7 而非 9）。
                let mut inner = pair.into_inner();
                let mut operands: Vec<AstNode> = Vec::new();
                let mut operators: Vec<String> = Vec::new();
                match inner.next() {
                    Some(first) => operands.push(self.build_ast(first)),
                    None => return AstNode::String("#ERROR!".to_string()),
                }
                while let Some(op) = inner.next() {
                    operators.push(op.as_str().to_string());
                    match inner.next() {
                        Some(term) => operands.push(self.build_ast(term)),
                        None => break, // 格式异常时安全截断
                    }
                }
                Self::build_with_precedence(operands, operators)
            },
            Rule::number => AstNode::Number(pair.as_str().parse().unwrap_or(0.0)),
            Rule::string => {
                let s = pair.as_str();
                AstNode::String(s[1..s.len()-1].to_string())
            },
            Rule::boolean => AstNode::Boolean(pair.as_str().to_uppercase() == "TRUE"),
            Rule::cell_ref => {
                match pair.into_inner().next() {
                    Some(child) => self.build_ast(child),
                    None => AstNode::String("#REF!".to_string()),
                }
            },
            Rule::a1_ref => {
                let s = pair.as_str();
                let (r, c) = self.parse_a1(s);
                // A1 标记法即便不带 $，在解析字符串公式时其行列值也是绝对的
                AstNode::CellRef { r: r as i32, c: c as i32, abs_r: true, abs_c: true }
            },
            Rule::r1c1_ref => {
                let s = pair.as_str();
                let (r, c, abs_r, abs_c) = self.parse_r1c1(s);
                AstNode::CellRef { r, c, abs_r, abs_c }
            },
            Rule::range => {
                let mut inner = pair.into_inner();
                let p1 = match inner.next() {
                    Some(p) => p,
                    None => return AstNode::String("#REF!".to_string()),
                };
                let p2 = match inner.next() {
                    Some(p) => p,
                    None => return AstNode::String("#REF!".to_string()),
                };
                let node1 = self.build_ast(p1);
                let node2 = self.build_ast(p2);
                if let (AstNode::CellRef { r: r1, c: c1, abs_r: ar1, abs_c: ac1 }, 
                        AstNode::CellRef { r: r2, c: c2, abs_r: ar2, abs_c: ac2 }) = (node1, node2) {
                    AstNode::Range { r1, c1, r2, c2, abs_r1: ar1, abs_c1: ac1, abs_r2: ar2, abs_c2: ac2 }
                } else {
                    AstNode::Number(0.0)
                }
            },
            Rule::function_call => {
                let mut inner = pair.into_inner();
                let name = match inner.next() {
                    Some(n) => n.as_str().to_string(),
                    None => return AstNode::String("#NAME?".to_string()),
                };
                let mut args = Vec::new();
                for p in inner {
                    args.push(self.build_ast(p));
                }
                AstNode::FunctionCall { name, args }
            },
            _ => AstNode::Number(0.0),
        }
    }

    fn eval_ast(&self, node: &AstNode, pos: (usize, usize)) -> CalcValue {
        match node {
            AstNode::Number(n) => CalcValue::Number(*n),
            AstNode::String(s) => CalcValue::String(s.clone()),
            AstNode::Boolean(b) => CalcValue::Boolean(*b),
            AstNode::CellRef { r, c, abs_r, abs_c } => {
                let fr = if *abs_r { *r } else { pos.0 as i32 + *r };
                let fc = if *abs_c { *c } else { pos.1 as i32 + *c };
                let val = self.get_shared_value(fr as usize, fc as usize);
                if val.is_nan() {
                    CalcValue::Error("#VALUE!".to_string())
                } else {
                    CalcValue::Number(val)
                }
            },
            AstNode::Range { r1, c1, r2, c2, abs_r1, abs_c1, abs_r2, abs_c2 } => {
                let fr1 = if *abs_r1 { *r1 } else { pos.0 as i32 + *r1 };
                let fc1 = if *abs_c1 { *c1 } else { pos.1 as i32 + *c1 };
                let fr2 = if *abs_r2 { *r2 } else { pos.0 as i32 + *r2 };
                let fc2 = if *abs_c2 { *c2 } else { pos.1 as i32 + *c2 };
                CalcValue::RangeView { 
                    r1: fr1 as usize, c1: fc1 as usize, 
                    r2: fr2 as usize, c2: fc2 as usize 
                }
            },
            AstNode::FunctionCall { name, args } => {
                if name == "SUM" {
                    let mut sum = 0.0;
                    for arg in args {
                        let eval_res = self.eval_ast(arg, pos);
                        if let CalcValue::Error(e) = eval_res { return CalcValue::Error(e); }
                        match eval_res {
                            CalcValue::Number(n) => sum += n,
                            CalcValue::RangeView { r1, c1, r2, c2 } => {
                                for r in r1..=r2 {
                                    for c in c1..=c2 {
                                        let val = self.get_shared_value(r, c);
                                        if val.is_nan() { return CalcValue::Error("#VALUE!".to_string()); }
                                        sum += val;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    CalcValue::Number(sum)
                } else {
                    let mut eval_args = Vec::new();
                    for arg in args {
                        let val = self.eval_ast(arg, pos);
                        if let CalcValue::Error(e) = val { return CalcValue::Error(e); }
                        match val {
                            CalcValue::RangeView { r1, c1, r2, c2 } => {
                                for r in r1..=r2 {
                                    for c in c1..=c2 {
                                        let v = self.get_shared_value(r, c);
                                        if v.is_nan() { return CalcValue::Error("#VALUE!".to_string()); }
                                        eval_args.push(CalcValue::Number(v));
                                    }
                                }
                            }
                            _ => eval_args.push(val),
                        }
                    }
                    self.registry.call(name, eval_args)
                }
            },
            AstNode::BinaryOp { left, op, right } => {
                let l = self.eval_ast(left, pos);
                if let CalcValue::Error(e) = l { return CalcValue::Error(e); }
                let r = self.eval_ast(right, pos);
                if let CalcValue::Error(e) = r { return CalcValue::Error(e); }
                match op.as_str() {
                    "+" => CalcValue::Number(l.as_f64() + r.as_f64()),
                    "-" => CalcValue::Number(l.as_f64() - r.as_f64()),
                    "*" => CalcValue::Number(l.as_f64() * r.as_f64()),
                    "/" => {
                        let r_val = r.as_f64();
                        if r_val == 0.0 {
                            CalcValue::Error("#DIV/0!".to_string())
                        } else {
                            CalcValue::Number(l.as_f64() / r_val)
                        }
                    },
                    "&" => CalcValue::String(format!("{}{}", l.as_string(), r.as_string())),
                    "=" => CalcValue::Boolean(l == r),
                    "<>" => CalcValue::Boolean(l != r),
                    "<" => CalcValue::Boolean(l.as_f64() < r.as_f64()),
                    ">" => CalcValue::Boolean(l.as_f64() > r.as_f64()),
                    "<=" => CalcValue::Boolean(l.as_f64() <= r.as_f64()),
                    ">=" => CalcValue::Boolean(l.as_f64() >= r.as_f64()),
                    _ => CalcValue::Error("#OP!".to_string()),
                }
            }
        }
    }

    fn parse_r1c1(&self, s: &str) -> (i32, i32, bool, bool) {
        let mut r = 0;
        let mut c = 0;
        let mut abs_r = true;
        let mut abs_c = true;

        // 防御性拆分：避免无 "C" 字符时 nth(1) panic
        let mut parts = s.split('C');
        let r_part = parts.next().unwrap_or("R0");
        let c_part = parts.next().unwrap_or("0");
        
        if r_part.contains('[') {
            abs_r = false;
            r = r_part.replace("R[", "").replace("]", "").parse().unwrap_or(0);
        } else if r_part.len() > 1 {
            r = r_part[1..].parse::<i32>().unwrap_or(1) - 1;
        }
        
        if c_part.contains('[') {
            abs_c = false;
            c = c_part.replace("[", "").replace("]", "").parse().unwrap_or(0);
        } else if !c_part.is_empty() {
            c = c_part.parse::<i32>().unwrap_or(1) - 1;
        }
        
        (r, c, abs_r, abs_c)
    }


    fn parse_a1(&self, a1: &str) -> (usize, usize) {
        let clean = a1.replace("$", "");
        let mut col_str = String::new();
        let mut row_str = String::new();
        for c in clean.chars() {
            if c.is_alphabetic() { col_str.push(c); }
            else { row_str.push(c); }
        }
        let mut col: usize = 0;
        for c in col_str.chars() { col = col * 26 + (c as usize - 'A' as usize + 1); }
        // 边界校验：防止解析为 0 后 usize 下溢越界（例如 "A0" 导致 row_str 为 "0"）
        let parsed_row: usize = row_str.parse::<usize>().unwrap_or(1);
        let row = if parsed_row > 0 { parsed_row - 1 } else { 0 };
        let col_idx = if col > 0 { col - 1 } else { 0 };
        (row, col_idx)
    }

    fn get_shared_value(&self, r: usize, c: usize) -> f64 {
        if let Some(ref buffer) = self.shared_buffer {
            if r < self.grid_rows && c < self.grid_cols {
                let val = buffer.get_index((r * self.grid_cols + c) as u32);
                // 如果是 -Infinity (JS 端定义的空值标记)，返回 0.0
                if val.is_infinite() && val.is_sign_negative() {
                    return 0.0;
                }
                return val;
            }
        }
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_a1_normal() {
        let engine = FormulaEngine::new();
        let (row, col) = engine.parse_a1("A1");
        assert_eq!(row, 0);
        assert_eq!(col, 0);
    }

    #[test]
    fn test_parse_a1_with_dollar() {
        let engine = FormulaEngine::new();
        let (row, col) = engine.parse_a1("$B$3");
        assert_eq!(row, 2);
        assert_eq!(col, 1);
    }

    #[test]
    fn test_parse_a1_row_zero_no_underflow() {
        // 验证 "A0" 不会触发 usize 下溢（原漏洞）
        let engine = FormulaEngine::new();
        let (row, col) = engine.parse_a1("A0");
        // 行号 0 无效，被边界校验截断为 0，不会 panic
        assert_eq!(row, 0);
        assert_eq!(col, 0);
    }

    #[test]
    fn test_parse_a1_empty_no_underflow() {
        // 验证空字符不会触发 usize 下溢
        let engine = FormulaEngine::new();
        let (row, _) = engine.parse_a1("AA");
        // 没有数字，row_str 为空，parse 用 unwrap_or(1)，结果为 0
        assert_eq!(row, 0);
    }

    #[test]
    fn test_parse_r1c1_normal() {
        let engine = FormulaEngine::new();
        let (r, c, abs_r, abs_c) = engine.parse_r1c1("R5C3");
        assert_eq!(r, 4); // R5 -> 1-based -> index 4
        assert_eq!(c, 2); // C3 -> 1-based -> index 2
        assert!(abs_r);
        assert!(abs_c);
    }

    #[test]
    fn test_parse_r1c1_relative() {
        let engine = FormulaEngine::new();
        let (r, c, abs_r, abs_c) = engine.parse_r1c1("R[2]C[1]");
        assert_eq!(r, 2);
        assert_eq!(c, 1);
        assert!(!abs_r);
        assert!(!abs_c);
    }

    #[test]
    fn test_parse_r1c1_no_c_suffix_no_panic() {
        // 验证无 "C" 字符时不会触发 unwrap panic（原漏洞）
        let engine = FormulaEngine::new();
        // 此调用不应 panic（原始代码在 split('C').nth(1).unwrap() 会 panic）
        let (r, c, _, _) = engine.parse_r1c1("R5");
        // 防御性 fallback：r_part="R5", c_part="0"
        assert_eq!(r, 4);  // R5 → 5 - 1 = 4
        assert_eq!(c, -1); // c_part "0" → 0 - 1 = -1 (i32 安全承载)
    }

    #[test]
    fn test_parse_r1c1_empty_suffix() {
        let engine = FormulaEngine::new();
        let (_, c, _, _) = engine.parse_r1c1("R1C");
        // C 后为空，c_part 为空字符串
        assert_eq!(c, 0);
    }

    // --- 语法错误不 panic 测试（通过 evaluate_internal，非 wasm-bindgen 导出） ---

    #[test]
    fn test_evaluate_syntax_error_unclosed_paren() {
        // 未闭合括号不应 panic（原 evaluate_group 会 panic 崩溃）
        let mut engine = FormulaEngine::new();
        let result = engine.evaluate_internal("=SUM(A1+");
        // 应返回 Error 类型而非 panic
        match result {
            CalcValue::Error(_) | CalcValue::String(_) => {}, // 优雅降级
            _ => panic!("Expected error for malformed formula, got: {:?}", result),
        }
    }

    #[test]
    fn test_evaluate_syntax_error_garbage() {
        // 完全不合法的公式不应 panic
        let mut engine = FormulaEngine::new();
        let result = engine.evaluate_internal("=@#$%!");
        // 只要没 panic 就通过，不关心具体返回值
        let _ = result;
    }

    #[test]
    fn test_evaluate_syntax_error_missing_operand() {
        // 二元运算符缺操作数不应 panic
        let mut engine = FormulaEngine::new();
        let result = engine.evaluate_internal("=1+");
        let _ = result; // 不 panic 即通过
    }

    #[test]
    fn test_evaluate_syntax_error_incomplete_range() {
        // 不完整的范围引用不应 panic
        let mut engine = FormulaEngine::new();
        let result = engine.evaluate_internal("=SUM(A1:)");
        let _ = result;
    }

    // ─── build_with_precedence 无恐慌测试 ───
    // 以下用例覆盖语法解析通过但操作数/运算符失衡的畸形输入，
    // 验证 build_with_precedence 的 unwrap 替换后不会触发 WASM panic。

    #[test]
    fn test_no_panic_trailing_operator() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=1+");
        let _ = engine.evaluate_internal("=1+2*");
        let _ = engine.evaluate_internal("=1+2-");
    }

    #[test]
    fn test_no_panic_double_operator() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=1++2");
        let _ = engine.evaluate_internal("=1**2");
        let _ = engine.evaluate_internal("=1//2");
    }

    #[test]
    fn test_no_panic_leading_operator() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=+1");
        let _ = engine.evaluate_internal("=-42");
        let _ = engine.evaluate_internal("=*100");
    }

    #[test]
    fn test_no_panic_consecutive_operators() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=1+-*/2");
    }

    #[test]
    fn test_no_panic_only_operator() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=+");
        let _ = engine.evaluate_internal("=-");
        let _ = engine.evaluate_internal("=*");
        let _ = engine.evaluate_internal("=/");
    }

    #[test]
    fn test_no_panic_many_operators() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=1+2+3+4+5+");
    }

    #[test]
    fn test_no_panic_empty_parens() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=()");
        let _ = engine.evaluate_internal("=SUM()");
        let _ = engine.evaluate_internal("=(1+)");
    }

    #[test]
    fn test_no_panic_nested_malformed() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=SUM(1+)");
        let _ = engine.evaluate_internal("=SUM(1+2*))");
        let _ = engine.evaluate_internal("=SUM((1+2)");
    }

    #[test]
    fn test_no_panic_incomplete_expr_after_paren() {
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=(1+2)+");
        let _ = engine.evaluate_internal("=(1+2)-");
        let _ = engine.evaluate_internal("=(1+2)*");
    }

    #[test]
    fn test_no_panic_bulk_malformed() {
        // 批量畸形公式，验证不会触发 WASM panic
        let mut engine = FormulaEngine::new();
        let malformed = vec![
            "=1+", "=1-", "=1*", "=1/",
            "=+", "=-", "=*", "=/",
            "=1++2", "=1+-2", "=1+*2",
            "=(1+2", "=1+2)", "=)",
            "=SUM(1+", "=SUM(+1,)", "=SUM(,1)",
            "=1+2+3+", "=1*2*3*", "=1+2*3/",
            "=A1+", "=+A1", "=A1+*B2",
        ];
        for formula in malformed {
            let _ = engine.evaluate_internal(formula);
        }
    }

    #[test]
    fn test_no_panic_very_long_operator_chain() {
        // 长运算符链缺操作数，不应溢出栈
        let mut engine = FormulaEngine::new();
        let _ = engine.evaluate_internal("=1+2+3+4+5+6+7+8+9+10+");
    }
}
