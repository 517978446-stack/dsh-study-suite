import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else { print("usage: ocr <image>"); exit(2) }
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("cannot load image"); exit(3)
}
let request = VNRecognizeTextRequest { req, err in
    guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
    for obs in observations {
        if let top = obs.topCandidates(1).first { print(top.string) }
    }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US", "zh-Hans"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([request])
