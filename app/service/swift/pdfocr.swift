import Foundation
import PDFKit
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else { print("usage: pdfocr <file.pdf> [maxPages]"); exit(2) }
let path = CommandLine.arguments[1]
let maxPages = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 5 : 5

guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
    print("cannot open pdf"); exit(3)
}

func ocr(_ image: NSImage) -> [String] {
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return [] }
    var lines: [String] = []
    let request = VNRecognizeTextRequest { req, _ in
        guard let results = req.results as? [VNRecognizedTextObservation] else { return }
        for obs in results {
            if let top = obs.topCandidates(1).first { lines.append(top.string) }
        }
    }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US", "zh-Hans"]
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    return lines
}

let pages = min(doc.pageCount, maxPages)
for index in 0..<pages {
    guard let page = doc.page(at: index) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2.0
    let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    let thumb = page.thumbnail(of: size, for: .mediaBox)
    for line in ocr(thumb) { print(line) }
}
