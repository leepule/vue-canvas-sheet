// Vue-Canvas-Sheet
// (c) 2026-present
// Released under the Apache License, Version 2.0.

use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[derive(Clone, Debug, PartialEq)]
pub enum CalcValue {
    Number(f64),
    String(String),
    Boolean(bool),
    RangeView { r1: usize, c1: usize, r2: usize, c2: usize },
    Error(String),
}

#[derive(Clone, Debug)]
pub enum AstNode {
    Number(f64),
    String(String),
    Boolean(bool),
    CellRef { r: i32, c: i32, abs_r: bool, abs_c: bool },
    Range { r1: i32, c1: i32, r2: i32, c2: i32, abs_r1: bool, abs_c1: bool, abs_r2: bool, abs_c2: bool },
    FunctionCall { name: String, args: Vec<AstNode> },
    BinaryOp { left: Box<AstNode>, op: String, right: Box<AstNode> },
}

impl CalcValue {
    pub fn as_f64(&self) -> f64 {
        match self {
            CalcValue::Number(n) => *n,
            CalcValue::Boolean(b) => if *b { 1.0 } else { 0.0 },
            CalcValue::String(s) => s.parse::<f64>().unwrap_or(0.0),
            _ => 0.0,
        }
    }

    pub fn as_bool(&self) -> bool {
        match self {
            CalcValue::Boolean(b) => *b,
            CalcValue::Number(n) => *n != 0.0,
            CalcValue::String(s) => !s.is_empty(),
            _ => false,
        }
    }

    pub fn as_string(&self) -> String {
        match self {
            CalcValue::String(s) => s.clone(),
            CalcValue::Number(n) => n.to_string(),
            CalcValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
            _ => "".to_string(),
        }
    }


    pub fn to_js_value(&self) -> JsValue {
        match self {
            CalcValue::Number(n) => {
                if n.is_nan() {
                    JsValue::from_str("#VALUE!")
                } else {
                    JsValue::from_f64(*n)
                }
            },
            CalcValue::String(s) => JsValue::from_str(s),
            CalcValue::Boolean(b) => JsValue::from_bool(*b),
            CalcValue::Error(e) => {
                if e.starts_with('#') {
                    JsValue::from_str(e)
                } else {
                    JsValue::from_str(&format!("#ERR: {}", e))
                }
            },
            _ => JsValue::NULL,
        }
    }
}

pub struct FunctionRegistry {
    functions: HashMap<String, Box<dyn Fn(Vec<CalcValue>) -> CalcValue>>,
}

impl FunctionRegistry {
    pub fn new() -> Self {
        let mut registry = Self {
            functions: HashMap::new(),
        };
        registry.register_all();
        registry
    }

    fn register_all(&mut self) {
        // --- 1. 数学聚合与运算 ---
        self.functions.insert("SUM".to_string(), Box::new(|args| {
            CalcValue::Number(args.iter().map(|v| v.as_f64()).sum())
        }));
        self.functions.insert("AVERAGE".to_string(), Box::new(|args| {
            if args.is_empty() { return CalcValue::Error("#DIV/0!".to_string()); }
            CalcValue::Number(args.iter().map(|v| v.as_f64()).sum::<f64>() / args.len() as f64)
        }));
        self.functions.insert("MAX".to_string(), Box::new(|args| {
            CalcValue::Number(args.iter().map(|v| v.as_f64()).fold(f64::MIN, f64::max))
        }));
        self.functions.insert("MIN".to_string(), Box::new(|args| {
            CalcValue::Number(args.iter().map(|v| v.as_f64()).fold(f64::MAX, f64::min))
        }));
        self.functions.insert("COUNT".to_string(), Box::new(|args| {
            CalcValue::Number(args.iter().filter(|v| matches!(v, CalcValue::Number(_))).count() as f64)
        }));
        self.functions.insert("COUNTA".to_string(), Box::new(|args| {
            CalcValue::Number(args.len() as f64)
        }));
        self.functions.insert("ABS".to_string(), Box::new(|args| {
            CalcValue::Number(args.first().map_or(0.0, |v| v.as_f64()).abs())
        }));
        self.functions.insert("SQRT".to_string(), Box::new(|args| {
            let n = args.first().map_or(0.0, |v| v.as_f64());
            if n < 0.0 { CalcValue::Error("#NUM!".to_string()) }
            else { CalcValue::Number(n.sqrt()) }
        }));
        self.functions.insert("ROUND".to_string(), Box::new(|args| {
            let n = args.get(0).map_or(0.0, |v| v.as_f64());
            let digits = args.get(1).map_or(0.0, |v| v.as_f64());
            let factor = 10.0f64.powf(digits);
            CalcValue::Number((n * factor).round() / factor)
        }));
        self.functions.insert("INT".to_string(), Box::new(|args| {
            CalcValue::Number(args.first().map_or(0.0, |v| v.as_f64()).floor())
        }));

        // --- 2. 文本函数 ---
        self.functions.insert("CONCAT".to_string(), Box::new(|args| {
            CalcValue::String(args.iter().map(|v| v.as_string()).collect())
        }));
        self.functions.insert("LEN".to_string(), Box::new(|args| {
            CalcValue::Number(args.first().map_or(0, |v| v.as_string().len()) as f64)
        }));
        self.functions.insert("UPPER".to_string(), Box::new(|args| {
            CalcValue::String(args.first().map_or("".to_string(), |v| v.as_string().to_uppercase()))
        }));
        self.functions.insert("LOWER".to_string(), Box::new(|args| {
            CalcValue::String(args.first().map_or("".to_string(), |v| v.as_string().to_lowercase()))
        }));
        self.functions.insert("LEFT".to_string(), Box::new(|args| {
            let s = args.get(0).map_or("".to_string(), |v| v.as_string());
            let n = args.get(1).map_or(1.0, |v| v.as_f64()) as usize;
            CalcValue::String(s.chars().take(n).collect())
        }));
        self.functions.insert("RIGHT".to_string(), Box::new(|args| {
            let s = args.get(0).map_or("".to_string(), |v| v.as_string());
            let n = args.get(1).map_or(1.0, |v| v.as_f64()) as usize;
            let len = s.chars().count();
            CalcValue::String(s.chars().skip(if n > len { 0 } else { len - n }).collect())
        }));

        // --- 3. 逻辑函数 ---
        self.functions.insert("IF".to_string(), Box::new(|args| {
            if args.is_empty() { return CalcValue::Error("#VALUE!".to_string()); }
            if args[0].as_bool() {
                args.get(1).cloned().unwrap_or(CalcValue::Boolean(true))
            } else {
                args.get(2).cloned().unwrap_or(CalcValue::Boolean(false))
            }
        }));
        self.functions.insert("AND".to_string(), Box::new(|args| CalcValue::Boolean(args.iter().all(|v| v.as_bool()))));
        self.functions.insert("OR".to_string(), Box::new(|args| CalcValue::Boolean(args.iter().any(|v| v.as_bool()))));
        self.functions.insert("NOT".to_string(), Box::new(|args| CalcValue::Boolean(!args.first().map_or(false, |v| v.as_bool()))));

        // --- 4. 日期函数 ---
        self.functions.insert("NOW".to_string(), Box::new(|_| {
            let now = js_sys::Date::new_0();
            let excel_epoch = js_sys::Date::new(&JsValue::from_str("1899-12-30")).get_time();
            let days = (now.get_time() - excel_epoch) / (24.0 * 60.0 * 60.0 * 1000.0);
            CalcValue::Number(days)
        }));
        self.functions.insert("TODAY".to_string(), Box::new(|_| {
            let now = js_sys::Date::new_0();
            now.set_hours(0); now.set_minutes(0); now.set_seconds(0); now.set_milliseconds(0);
            let excel_epoch = js_sys::Date::new(&JsValue::from_str("1899-12-30")).get_time();
            let days = (now.get_time() - excel_epoch) / (24.0 * 60.0 * 60.0 * 1000.0);
            CalcValue::Number(days.floor())
        }));
        self.functions.insert("YEAR".to_string(), Box::new(|args| {
            let serial = args.first().map_or(0.0, |v| v.as_f64());
            CalcValue::Number(Self::excel_to_js_date(serial).get_full_year() as f64)
        }));
        self.functions.insert("MONTH".to_string(), Box::new(|args| {
            let serial = args.first().map_or(0.0, |v| v.as_f64());
            CalcValue::Number(Self::excel_to_js_date(serial).get_month() as f64 + 1.0)
        }));
        self.functions.insert("DAY".to_string(), Box::new(|args| {
            let serial = args.first().map_or(0.0, |v| v.as_f64());
            CalcValue::Number(Self::excel_to_js_date(serial).get_date() as f64)
        }));
    }

    fn excel_to_js_date(serial: f64) -> js_sys::Date {
        let excel_epoch = js_sys::Date::new(&JsValue::from_str("1899-12-30")).get_time();
        let ms = excel_epoch + serial * 24.0 * 60.0 * 60.0 * 1000.0;
        js_sys::Date::new(&JsValue::from_f64(ms))
    }

    pub fn call(&self, name: &str, args: Vec<CalcValue>) -> CalcValue {
        if let Some(f) = self.functions.get(&name.to_uppercase()) {
            f(args)
        } else {
            CalcValue::Error("#NAME?".to_string())
        }
    }
}
