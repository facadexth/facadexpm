import PDFKit
import AppKit
// usage: dump pdf outdir scale page1 page2 ...
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let out = a[2]; let scale = CGFloat(Double(a[3])!)
var all: [String: Any] = [:]
for ps in a[4...] {
  autoreleasepool {
  let pn = Int(ps)!
  let p = doc.page(at: pn-1)!
  let box = p.bounds(for: .mediaBox)
  let s = (p.string ?? "") as NSString
  var words: [[Any]] = []
  var cur = ""; var r = CGRect.null
  func flush() { if !cur.isEmpty && !r.isNull { words.append([cur, Double(r.minX), Double(r.minY), Double(r.maxX), Double(r.maxY)]) }; cur = ""; r = .null }
  for i in 0..<s.length {
    let ch = s.substring(with: NSRange(location: i, length: 1))
    if ch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { flush(); continue }
    let b = p.characterBounds(at: i)
    if b.isEmpty || b.width.isNaN { cur += ch; continue }
    if !r.isNull {
      let gap = b.minX - r.maxX
      if abs(b.midY - r.midY) > max(b.height, r.height) * 0.6 || gap > b.height * 0.8 || gap < -b.height { flush() }
    }
    cur += ch; r = r.isNull ? b : r.union(b)
  }
  flush()
  all[String(pn)] = ["w": box.width, "h": box.height, "words": words]
  // render
  let W = Int(box.width*scale), H = Int(box.height*scale)
  let cs = CGColorSpaceCreateDeviceGray()
  let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x:0,y:0,width:W,height:H))
  ctx.scaleBy(x: scale, y: scale)
  ctx.translateBy(x: -box.minX, y: -box.minY)
  ctx.interpolationQuality = .high
  p.draw(with: .mediaBox, to: ctx)
  let img = ctx.makeImage()!
  let rep = NSBitmapImageRep(cgImage: img)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/r\(String(format: "%03d", pn)).png"))
  }
}
let d = try! JSONSerialization.data(withJSONObject: all)
try! d.write(to: URL(fileURLWithPath: "\(out)/words-\(a[4]).json"))
