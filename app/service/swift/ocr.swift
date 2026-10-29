import Foundation
import Vision
import AppKit

// 用法：
//   ocr <image>           每行一段文字
//   ocr --json <image>    JSON 数组：[{text, x, y, w, h}]，坐标是图片像素（左上原点）
//
// --json 是为了课表截图：只有文字没有坐标时，列对不上，课会串到别的周几。
guard CommandLine.arguments.count > 1 else { print("usage: ocr [--json] <image>"); exit(2) }
let wantJson = CommandLine.arguments.contains("--json")
let path = CommandLine.arguments.last!
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("cannot load image"); exit(3)
}
let width = CGFloat(cg.width)
let height = CGFloat(cg.height)

var rows: [[String: Any]] = []
let request = VNRecognizeTextRequest { req, err in
    guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        let box = obs.boundingBox            // 归一化，原点在左下
        let x = box.origin.x * width
        let w = box.size.width * width
        let h = box.size.height * height
        let y = (1 - box.origin.y - box.size.height) * height   // 换成左上原点
        rows.append(["text": top.string, "x": Double(x), "y": Double(y), "w": Double(w), "h": Double(h)])
    }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US", "zh-Hans"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([request])

if wantJson {
    if let data = try? JSONSerialization.data(withJSONObject: rows, options: []),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
} else {
    for row in rows { if let text = row["text"] as? String { print(text) } }
}
