/*
  TODO:
    用户密码不能明文存储   md5(md5(md5(password)))
    实时更新投票数据
    未登录不能为非匿名问题投票，以及相关的其他权限验证
    问题过期后不能再进行投票，只能查看结果
        问题过期后投票结果也不会在进行实时更新，所以不再需要建立socket连接
    各个页面的交互，不能只返回一个由文字组成的页面
    整站的所有页面都有头部和底部（用模板）
    创建投票的页面交互优化
    创建投票的后端需要额外的验证
        验证选项的数量 >=2
        过期时间需要是未来时间点
    页面UI的优化（bootstarp）
    登录后可以查看自己发起过的投票
    各种数据库操作出错的时候要对前端有正确的返回

    登陆时需要输入验证码
    注册时可以上传头像
*/

const express = require('express')
const cookieParser = require('cookie-parser')
const sqlite = require('sqlite')
const socketIo = require('socket.io')
const http = require('http')
const path = require('path')
const url = require('url')
const sharp = require('sharp')
const fs = require('fs')
const fsp = fs.promises
const svgCaptcha = require('svg-captcha')
const session = require('express-session')
var md5 = require('md5')
const multer = require('multer')
const uploader = multer({
  dest: './upload/',
  preservePath: true    
})

// 建立socket连接
const app = express()
const server = http.createServer(app)
const ioserver = socketIo(server)

const port = 3008

// 创建一个静态库，现实中应该是一个数据库
const dbPromise = sqlite.open(__dirname + '/db/voting-site.sqlite3')
let db

// 更改密码时，令牌和更改密码的用户之间的映射
const changePasswordTokenMap = {}
const sessions = {}

ioserver.on('connection', socket => {
  // var path = url.parse(socket.request.headers.referer).path

  socket.on('select room', roomid => {
    socket.join('/vote/' + roomid)
  }) 
  socket.join(path)
})


// 美化模板输出
app.locals.pretty = true
// 设置模板路径
app.engine('pug', require('pug').__express)
app.set('views', path.join(__dirname, './tpl'))
// 模板类型（不写默认为pug）
app.set('view engine', 'pug')


// 创建cookie
app.use(cookieParser('my secret'))

// app.use(session({secret: 'my secret', resave: false, cookie: { maxAge: 60000 }}))
app.use(function session (req, res, next) {
  var sessionid = req.cookies.sessionid
  if (!sessionid) {
    res.cookie('sessionid', Math.random().toString(16).slice(2))
  }
  if (!sessions[sessionid]) {
    sessions[sessionid] = {}
  }
  req.session = sessions[sessionid]
  next()
})

// 解析url编码请求的中间件
app.use(express.urlencoded({
  extended: true
}))

// 解析json请求体的中间件
app.use(express.json())

// 这里用path是因为不同命令行工具可能路径格式不一样
app.use(express.static(path.join(__dirname, './static')))
app.use('/upload', express.static(__dirname + '/upload'))

// 简陋的设置一下响应头的文本格式
app.use((req, res, next) => {
  res.set("Content-type", "text/html; charset=UTF-8")
  next()
})


app.post('/create-vote', async (req, res, next) => {
  // 创建投票页面，将数据导入数据库
  var voteInfo = req.body
  await db.run(
    'INSERT INTO votes (title, desc, deadline, anonymous, singleSelection, userid) VALUES (?, ?, ?, ?, ?, ?)',
    voteInfo.title, voteInfo.desc, voteInfo.deadline, voteInfo.anonymous, voteInfo.singleSelection, req.signedCookies.userid
  )
  var vote = await db.get('SELECT * FROM votes ORDER BY id DESC LIMIT 1')
  await Promise.all(voteInfo.options.map(option => {
    return db.run('INSERT INTO options (content, voteid) VALUES (?,?)', option, vote.id)
  }))
  // 用vue请求 post发的是json格式，下面的是兼容之前写的表单发送的数据
  if (req.is('json')) {
    res.json(vote)
  } else {
    res.redirect('/vote/' + vote.id)
  }
})

app.get('/vote/:id', async (req, res, next) => {

  // 这里同时创建两个promise再两个await的目的是让两个promise同时加载，提高运行效率
  var votePromise = db.get('SELECT * FROM votes WHERE id=?', req.params.id)
  var optionsPromise = db.all('SELECT * FROM options WHERE voteid=?', req.params.id)
  var vote = await votePromise
  var options = await optionsPromise

  // 利用模板进行渲染
  res.render('vote.pug', {
    vote: vote,
    options: options
  })
})

// 获取某个投票的基本信息
app.get('/voteinfo/:id', async (req, res, next) => {
  var info = await db.get('SELECT * FROM votes WHERE id=?', req.params.id)
  var options = await db.all('SELECT * FROM options WHERE voteid=?', req.params.id)
  var voteups = await db.all('SELECT * FROM voteups WHERE voteid=?', req.params.id)
  res.json({
    info, options, voteups
  })
})


// 某个用户投票前获取某个问题的投票信息
app.get('/voteup/:voteid/info', async (req, res, next) => {
  var userid = req.signedCookies.userid
  var voteid = req.params.voteid

  var userVoteupInfo = await db.get(
    'SELECT * FROM voteups WHERE userid=? AND voteid=?', userid, voteid
  )

  if (userVoteupInfo) {
    var voteups = await db.all('SELECT * FROM voteups WHERE voteid=?', voteid)
    res.json(voteups)
  } else {
    res.json(null)
  }
})

// 用户投票
app.post('/voteup', async (req, res, next) => {

  // 接收到投票数据，判断该用户是否已在该问题下投过票
  // 如果投过了，就update数据，没投过就插入数据
  var userid = req.signedCookies.userid
  var body = req.body
  var voteid = body.voteid
  var optionid = body.optionid

  var voteupInfo = await db.get('SELECT * FROM voteups WHERE userid=? AND voteid=?', userid, voteid)

  if (voteupInfo) {
    // 已经投过的票就不能改了
    // return res.end()
    await db.run('UPDATE voteups SET optionid=? WHERE userid=?', optionid, userid)
  } else {
    await db.run(
      'INSERT INTO voteups (userid, optionid, voteid) VALUES (?, ?, ?)',
      userid, optionid, voteid
    )
  }
      ioserver.in(`/vote/${voteid}`).emit('new vote', {
        userid,
        voteid,
        optionid
      })
      // ioserver.in(`/vote-vue.html?id=${voteid}`).emit('new vote', {
      //   userid,
      //   voteid,
      //   optionid
      // })

  var voteups = await db.all('SELECT * FROM voteups WHERE voteid=?', voteid)
  res.json(voteups)
})

app.get('/captcha', (req, res, next) => {
  var captcha = svgCaptcha.create({
    ignoreChars: '0o1il'
  })
  req.session.captcha = captcha.text

  res.type('svg')
  res.send(captcha.data)
})

// 首页如果有cookie的用户直接进入，
// 如果没有则需要先登录或注册
app.get('/', async (req, res, next) => {
  if (req.signedCookies.userid) {
    var user = await db.get('SELECT * FROM users WHERE id=?', req.signedCookies.userid)
    res.render('hello.pug', { user: user })
  } else {
    res.render('login.pug')
  }
})

// 由于HTTP是无状态相应，创建cookie目的是便于再次登陆时直接登陆
// 为登陆的用户创建cookie
app.post('/login', async (req, res, next) => {
  var tryLogInfo = req.body
  if (tryLogInfo.captcha.toLowerCase() != req.session.captcha.toLowerCase()) {
    res.send('验证码错误')
  }
  var loginSec = await db.get('SELECT * FROM users WHERE name=? AND password=?',
    tryLogInfo.name, md5(md5(tryLogInfo.password))
  )
  if (loginSec) {
    res.cookie('userid', loginSec.id, {
      signed: true
    })
    res.redirect('/')
  } else {
    res.render('passwordWrong.pug')
  }
})

app.get('/logout', (req, res, next) => {
  // 退出登陆，清除cookie
  res.clearCookie('userid')
  res.redirect('/')
})

app.route('/register')
  .get((req, res, next) => {
    res.render('regisiter.pug')
  })
  .post(uploader.single('avatar'), async (req, res, next) => {
    var regInfo = req.body
    console.log(regInfo, req.file)
    
    var imgBuf = await fsp.readFile(req.file.path)
    await sharp(imgBuf)
      .resize(200)
      .toFile(req.file.path)

    var userName = await db.get('SELECT * FROM users WHERE name = "' + regInfo.name + '"')
    var userEmail = await db.get('SELECT * FROM users WHERE email = "' + regInfo.email + '"')
    if (userName) {
      res.end('用户名已被注册')
    } if (userEmail) {
      res.end('邮箱已被注册')
    } else {
      // 下面等价上面一行，为上面一行的简写
      // db.run('INSERT INTO user (name, email, password) VALUES ('+regInfo.name+','+regInfo.email+','+regInfo.password+')')
      await db.run(
        // 存储文件的常规操作是  avatar 类存在users中
        // avarar 的详细信息单独在数据库中创建一个表格，将 id,name,originalname,path,size,mime 的信息存入
        // 这些信息如果不存入，系统读取文件时可能会出错
        // 这里只存图片，系统一般可以识别，为了...，就不单独创建一个表格了
        'INSERT INTO users (name, email, password, avatar) VALUES (?,?,?,?)',
        regInfo.name, regInfo.email, md5(md5(regInfo.password)), req.file.path
      )
      res.end('注册成功')
    }
  })

app.route('/forget')
  .get((req, res, next) => {
    res.end(`
      <form method="post" action="/forget">
        请输入您的邮箱：<input type="email" name="email" />
        <button>确定</button>
      </form>
    `)
  })
  .post(async (req, res, next) => {

    // 忘记密码的邮箱先与令牌（token）建立映射关系
    // token 是一个随机数，20分钟无操作需清除
    var email = req.body.email
    var token = Math.random().toString().slice(2)
    changePasswordTokenMap[token] = email

    setTimeout(() => {
      delete changePasswordTokenMap[token]
    }, 60 * 1000 * 20)
    if (await db.get('SELECT * FROM users WHERE email = ?', email)) {
      var link = `http://localhost:3008/changePassword/${token}`

      // 这里实际上是要向目标邮箱发送一个邮件的
      // 暂时用log代替
      console.log(link)

      res.end('已向您的邮箱发送重置链接，请于20分钟内操作')
    } else {
      res.end('请输入正确邮箱')
    }
  })

app.route('/changePassword/:token')
  .get(async (req, res, next) => {
    var token = req.params.token
    var email = changePasswordTokenMap[token]
    if (!email) {
      res.end('链接已失效')
      return
    }
    var user = await db.get('SELECT * FROM users WHERE email=?', changePasswordTokenMap[token])
    res.end(`
      <form method="post" action="">
        <h3>正在重置${user.name}用户密码</h3><br>
        <input type="password" name="password" />
        <button>确定</button>
      </form>
    `)
  })
  .post(async (req, res, next) => {
    var token = req.params.token
    var email = changePasswordTokenMap[token]
    if (!email) {
      res.end('链接已失效')
      return
    }
    await db.run('UPDATE users SET password=? WHERE email=?', md5(md5(req.body.password)), changePasswordTokenMap[token])
    // 重置密码后，令牌失效
    delete changePasswordTokenMap[token]
    res.end('密码重置成功')
  })

dbPromise.then(dbObject => {
  db = dbObject
  server.listen(port, () => {
    console.log('listening in port', port)
  })
})