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
                    let ast = self.build_ast(pairs.into_iter().next().unwrap());
                    self.ast_cache.insert(formula.to_string(), ast.clone());
                    ast
                },
                Err(_) => AstNode::Boolean(false),
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
            let pairs = FormulaParser::parse(Rule::formula, formula).unwrap();
            let ast = self.build_ast(pairs.into_iter().next().unwrap());
            self.ast_cache.insert(formula.to_string(), ast.clone());
            ast
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
                    if !has_shared {
                        numeric_vals.push(f64::NAN); // 占位符
                    }
                    let cell_id = ids.get(i);
                    Reflect::set(&non_numeric, &cell_id, &res.to_js_value()).unwrap();
                }
            }
        }

        let output = Object::new();
        // 仅在无共享内存时返回 numeric_results（降级路径）
        if !has_shared {
            Reflect::set(&output, &"numeric_results".into(), &Float64Array::from(numeric_vals.as_slice()).into()).unwrap();
        }
        Reflect::set(&output, &"non_numeric_results".into(), &non_numeric.into()).unwrap();
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
    fn build_with_precedence(operands: Vec<AstNode>, operators: Vec<String>) -> AstNode {
        let mut out: Vec<AstNode> = Vec::new();
        let mut ops: Vec<String> = Vec::new();
        let mut operand_iter = operands.into_iter();
        out.push(operand_iter.next().unwrap());

        let reduce = |out: &mut Vec<AstNode>, op: String| {
            let right = out.pop().unwrap();
            let left = out.pop().unwrap();
            out.push(AstNode::BinaryOp { left: Box::new(left), op, right: Box::new(right) });
        };

        for op in operators {
            let prec = Self::op_precedence(&op);
            // 左结合：栈顶优先级 >= 当前则先归约
            while let Some(top) = ops.last() {
                if Self::op_precedence(top) >= prec {
                    let top_op = ops.pop().unwrap();
                    reduce(&mut out, top_op);
                } else {
                    break;
                }
            }
            ops.push(op);
            out.push(operand_iter.next().unwrap());
        }
        while let Some(top_op) = ops.pop() {
            reduce(&mut out, top_op);
        }
        out.pop().unwrap()
    }

    fn build_ast(&self, pair: pest::iterators::Pair<Rule>) -> AstNode {
        match pair.as_rule() {
            Rule::formula => self.build_ast(pair.into_inner().next().unwrap()),
            Rule::expr => {
                // 收集扁平的 term/op 序列后，按标准运算符优先级构建 AST，
                // 而非简单的从左到右折叠（保证 =1+2*3 得 7 而非 9）。
                let mut inner = pair.into_inner();
                let mut operands: Vec<AstNode> = Vec::new();
                let mut operators: Vec<String> = Vec::new();
                operands.push(self.build_ast(inner.next().unwrap()));
                while let Some(op) = inner.next() {
                    operators.push(op.as_str().to_string());
                    operands.push(self.build_ast(inner.next().unwrap()));
                }
                Self::build_with_precedence(operands, operators)
            },
            Rule::number => AstNode::Number(pair.as_str().parse().unwrap_or(0.0)),
            Rule::string => {
                let s = pair.as_str();
                AstNode::String(s[1..s.len()-1].to_string())
            },
            Rule::boolean => AstNode::Boolean(pair.as_str().to_uppercase() == "TRUE"),
            Rule::cell_ref => self.build_ast(pair.into_inner().next().unwrap()),
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
                let p1 = inner.next().unwrap();
                let p2 = inner.next().unwrap();
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
                let name = inner.next().unwrap().as_str().to_string();
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
        
        let r_part = s.split('C').next().unwrap();
        let c_part = s.split('C').nth(1).unwrap();
        
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
        let row: usize = row_str.parse::<usize>().unwrap_or(1) - 1;
        (row, col - 1)
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
