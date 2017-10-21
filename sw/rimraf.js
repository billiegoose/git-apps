// Because isaacs "rimraf" is too Node-specific

const pfy = function (fn) {
  return function (a, cb) {
    return new Promise(function(resolve, reject) {
      fn(a, (err, result) => err ? reject(err) : resolve(result))
    });
  }
}

const readdir = pfy(fs.readdir.bind(fs))
const unlink = pfy(fs.unlink.bind(fs))
const rmdir = pfy(fs.rmdir.bind(fs))

// It's elegant in it's naivety
async function rimraf (path) {
  // First, assume everything is a file.
  let files = await readdir(path)
  for (let file of files) {
    let child = path + '/' + file
    try {
      await fs.unlink(child)
    } catch (err) {
      console.log('err =', err)
    }
  }
  // Assume what's left are directories and recurse.
  let dirs = await readdir(path)
  for (let dir of dirs) {
    let child = path + '/' + dir
    try {
      await rimraf(child)
    } catch (err) {
      console.log('err =', err)
    }
  }
  // Finally, delete the empty directory
  await rmdir(path)
}