import PDFKit
import AppKit
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let out = a[2]; let target: CGFloat = CGFloat(Double(a[3]) ?? 1800)
var text = ""
for i in 0..<doc.pageCount {
  autoreleasepool {
  let p = doc.page(at: i)!
  let r = p.bounds(for: .cropBox)
  let rot = p.rotation % 180 != 0
  let w = rot ? r.height : r.width, h = rot ? r.width : r.height
  let s = target / max(w, h)
  let img = p.thumbnail(of: NSSize(width: w*s, height: h*s), for: .cropBox)
  let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
  try! rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72])!.write(to: URL(fileURLWithPath: "\(out)/p\(String(format: "%03d", i+1)).jpg"))
  text += "\n=== PAGE \(i+1) ===\n" + (p.string ?? "")
  }
}
try! text.write(toFile: "\(out)/text.txt", atomically: true, encoding: .utf8)
print(doc.pageCount)
