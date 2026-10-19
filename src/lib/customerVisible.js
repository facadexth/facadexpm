// Which attachment files can be shown to the customer on LINE (images only).
export const isCustomerImage = (fileName) => /\.(jpe?g|png)$/i.test(fileName || '')
