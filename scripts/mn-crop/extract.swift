import PDFKit
import AppKit
// usage: extract pdf outdir scale pages.json   (pages.json: {"17":["U1573",...]})
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let out = a[2]; let scale = CGFloat(Double(a[3])!)
let req = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[4]))) as! [String: [String]]
func rr(_ b: CGRect) -> [Double] { [Double(b.minX), Double(b.minY), Double(b.maxX), Double(b.maxY)] }
func isAlnum(_ c: unichar) -> Bool { (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) }
var all: [String: Any] = [:]
for (ps, dies) in req {
  autoreleasepool {
  let pn = Int(ps)!
  let p = doc.page(at: pn-1)!
  let box = p.bounds(for: .mediaBox)
  let s = (p.string ?? "") as NSString
  func hits(_ q: String, boundary: Bool) -> [[Double]] {
    var res: [[Double]] = []
    var r = s.range(of: q)
    while r.location != NSNotFound {
      var ok = true
      if boundary {
        if r.location > 0 && isAlnum(s.character(at: r.location-1)) { ok = false }
        let e = r.location + r.length
        if e < s.length && isAlnum(s.character(at: e)) { ok = false }
      }
      if ok, let sel = p.selection(for: r) { let b = sel.bounds(for: p); if !b.isNull && !b.isEmpty { res.append(rr(b)) } }
      let st = r.location + r.length
      r = s.range(of: q, range: NSRange(location: st, length: s.length - st))
    }
    return res
  }
  var dh: [String: Any] = [:]
  for d in dies { dh[d] = hits(d, boundary: true) }
  var lines: [[Any]] = []
  if let sa = p.selection(for: box) {
    for l in sa.selectionsByLine() { let b = l.bounds(for: p); if !b.isNull && !b.isEmpty { lines.append([l.string ?? ""] + rr(b).map{ $0 as Any }) } }
  }
  all[ps] = ["w": Double(box.width), "h": Double(box.height), "dies": dh, "dieno": hits("DIE NO", boundary: false), "kg": hits("KG./M", boundary: false), "lines": lines]
  let W = Int(box.width*scale), H = Int(box.height*scale)
  let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x:0,y:0,width:W,height:H))
  ctx.scaleBy(x: scale, y: scale); ctx.translateBy(x: -box.minX, y: -box.minY)
  p.draw(with: .mediaBox, to: ctx)
  let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/r\(String(format: "%03d", pn)).png"))
  }
}
let d = try! JSONSerialization.data(withJSONObject: all)
try! d.write(to: URL(fileURLWithPath: "\(out)/hits.json"))
