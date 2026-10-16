import PDFKit
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
if a.count > 2 {
  var out = ""
  for i in 0..<doc.pageCount { out += "\n=== PAGE \(i+1) ===\n" + (doc.page(at: i)?.string ?? "") }
  try! out.write(toFile: a[2], atomically: true, encoding: .utf8)
} else {
  var chars = 0
  for i in 0..<doc.pageCount { chars += doc.page(at: i)?.string?.count ?? 0 }
  print(doc.pageCount, chars)
}
