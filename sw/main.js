global = self
window = global
importScripts('./sw/fs.js')
importScripts('./sw/mime.js')
importScripts('https://unpkg.com/omnipath@1.1.5/dist/omnipath.min.js')
importScripts('./sw/render-index.js')
importScripts('./sw/rimraf.js')
importScripts('https://unpkg.com/isomorphic-git@0.0.12/dist/bundle.umd.min.js')

console.log('git =', git)
console.log('OmniPath =', OmniPath)
console.log('renderIndex =', renderIndex)
console.log('BrowserFS =', BrowserFS)

async function clone ({ref, repo, name}) {
  await fsReady
  let dir = name + '-' + ref
  return git(dir)
    .depth(1)
    .branch(ref)
    .clone(`https://cors-buster-jfpactjnem.now.sh/github.com/${repo}`)
}

self.addEventListener('install', event => {
  return event.waitUntil((async () => {
    await fsReady
    console.log('skipWaiting()')
    await self.skipWaiting()
    console.log('skipWaiting() complete')
  })())
})

self.addEventListener('activate', event => {
  return event.waitUntil((async () => {
    console.log('claim()')
    await self.clients.claim()
    console.log('claim() complete')
  })())
})

self.addEventListener('message', event => {
  console.log(event.data)
  if (event.data.type === 'clone') {
    clone(event.data).then(() => {
      console.log('Done cloning.')
      let msg = {
        type: 'status',
        status: 'complete',
        regarding: event.data
      }
      console.log('event =', event)
      self.clients.matchAll().then(all => all.map(client => client.postMessage(msg)));
    }).catch(err => {
      let msg = {
        type: 'status',
        status: 'error',
        regarding: event.data,
        error: {
          message: err.message
        }
      }
      self.clients.matchAll().then(all => all.map(client => client.postMessage(msg)));
    })
  } else if (event.data.type === 'list') {
    console.log('listing')
    fs.readdir('/', (err, files) => {
      console.log('files =', files)
      let msg = {
        type: 'UpdatedDirectoryList',
        regarding: event.data,
        list: files
      }
      self.clients.matchAll().then(all => all.map(client => client.postMessage(msg)));
    })
  } else if (event.data.type == 'delete') {
    console.log('deleting')
    rimraf(event.data.directory).then(() => {
      fs.readdir('/', (err, files) => {
        console.log('files =', files)
        let msg = {
          type: 'UpdatedDirectoryList',
          regarding: event.data,
          list: files
        }
        self.clients.matchAll().then(all => all.map(client => client.postMessage(msg)));
      })
    })
  }
})

self.addEventListener('fetch', event => {
  let request = event.request
  // We need to cache GET (readFile) and HEAD (getFileSize) requests for proper offline support.
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  // Is it for a package CDN?
  const requestHost = OmniPath.parse(request.url).hostname
  if (requestHost === 'unpkg.com') return event.respondWith(permaCache(request, 'unpkg'))
  if (requestHost === 'wzrd.in') return event.respondWith(permaCache(request, 'wzrd'))
  if (requestHost === 'cdnjs.cloudflare.com') return event.respondWith(permaCache(request, 'cdnjs'))
  if (requestHost === 'api.cdnjs.com') return event.respondWith(permaCache(request, 'cdnjs'))
  if (requestHost === 'rawgit.com') return event.respondWith(permaCache(request, 'rawgit'))
  // For now, ignore other domains. We might very well want to cache them later though.
  if (!request.url.startsWith(self.location.origin)) return
  // Turn URL into a file path
  let path = request.url.replace(/^(https?:)?\/\/[^\/]+/, '')
  // Sanity check
  if (path === '') path = '/'
  // Don't try to look up ourself in the filesystem.
  if (path === '/' || path.startsWith('/sw')) return
  // Otherwise, try fetching from the "file system".
  event.respondWith(tryFsFirst(path))
})

async function permaCache (request, name) {
  let betterRequest = new Request(request.url, {
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow'
  })
  let cache = await caches.open(name)
  let response = await cache.match(betterRequest.url)
  console.log('request.url =', betterRequest.url)
  if (response) {
    console.log('yay!', betterRequest.url)
    return response
  }
  response = fetch(betterRequest)
  response.then(res => {
    console.log('Y U NOT CACHED?', betterRequest)
    console.log(res.status, betterRequest.url, res.url)
    // Note: It is important that we use the response URL,
    // not the request URL, unless you want to permanently
    // resolve redirects. I only want to permanently resolve
    // exact versions.
    if (res.status === 200) cache.put(request.url, res.clone())
    // Changed my mind. Let's just cache the redirected result,
    // because that gives us true offline support, version pinning
    // be damned.
    // if (res.status === 302) cache.put(betterRequest.url, res.clone())
  })
  return response
}

async function tryFsFirst (path) {
  return new Promise(function(resolve, reject) {
    fsReady.then(() => {
      fs.stat(path, (err, stats) => {
        if (err) {
          if (err.code === 'ENOENT') console.log(path + ' ain\'t there')
          else console.log('A more interesting error occurred!', err)
          let response = fetch(path)
          response
          .then(res => {
            console.log('---HEYHEY')
            if (!res.ok) return
            res.clone().text().then(content => {
              console.log('---Saving results')
              fs.writeFile(path, content, 'utf8')
            })
          })
          .catch(console.log)
          return resolve(response)
        } else if (stats.isDirectory()) {
          console.log(path + ' is a Directory!')
          // If the directory doesn't end in a slash, redirect it
          // because otherwise relative URLs will have trouble.
          if (!path.endsWith('/')) return resolve(Response.redirect(path + '/', 302))
          console.log('fs =', fs)
          fs.readdir(path, (err, data) => {
            if (err) return reject(err)
            // data = JSON.stringify(data, null, 2)
            console.log('data =', data)
            // Serve directory/index.html if it exists
            if (data.includes('index.html')) {
              fs.readFile(`${path}/index.html`, 'utf8', (err, data) => {
                if (err) return reject(err)
                return resolve(new Response(data, {
                  headers: {
                    'Content-Type': 'text/html'
                  }
                }))
              })
            } else {
              // If it doesn't exist, generate a directory index
              try {
                data = renderIndex(path, data)
              } catch (e) {
                console.log('e =', e)
              }
              console.log('data =', data)
              return resolve(new Response(data, {
                headers: {
                  'Content-Type': 'text/html'
                }
              }))
            }
          })
        } else {
          fs.readFile(path, 'utf8', (err, data) => {
            if (err) return reject(err)
            return resolve(new Response(data, {
              headers: {
                'Content-Type': mime.lookup(path)
              }
            }))
          })
        }
      })
    })
  })
}