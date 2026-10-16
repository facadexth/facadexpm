import PDFKit
let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!
var rots = [Int:Int]()
for i in 0..<doc.pageCount { let p = doc.page(at:i)!; rots[p.rotation, default:0] += 1
 if i < 3 || i == 16 || i == 245 { print(i+1, p.rotation, p.bounds(for:.cropBox), p.bounds(for:.mediaBox)) } }
print(rots)
