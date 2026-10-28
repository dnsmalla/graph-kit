// Native timing driver: reads one binary input file, runs the layout `runs` times,
// prints per-run wall time (ms) and writes the output of the first run to `out`.
use layout_t0::run_bytes;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = std::fs::read(&args[1]).expect("read input");
    let runs: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
    let mut first: Option<Vec<u8>> = None;
    let mut times = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        let out = run_bytes(&input).expect("layout");
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        if first.is_none() {
            first = Some(out);
        }
    }
    if let Some(out_path) = args.get(3) {
        std::fs::write(out_path, first.unwrap()).expect("write out");
    }
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("median_ms={:.1} runs_ms={:?}", sorted[sorted.len() / 2], times.iter().map(|t| format!("{:.0}", t)).collect::<Vec<_>>());
}
