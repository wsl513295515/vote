const express = require('express')
const cookieParser = require('cookie-parser')
const sqlite = require('sqlite')
const path = require('path')

const port = 3008

// 创建一个静态库，现实中应该是一个数据库
const dbPromise = sqlite.open(__dirname + '/db/voting-site.sqlite3')
let db

// 更改密码时，令牌和更改密码的用户之间的映射
const changePasswordTokenMap = {}

const app = express()

// 美化模板输出
app.locals.pretty = true
// 设置模板路径
app.set('views', path.join(__dirname, './tpl'))
// 模板类型（不写默认为pug）
app.set('view engine', 'pug')

// 创建cookie
app.use(cookieParser('my secret'))

// 解析url编码请求的中间件
app.use(express.urlencoded({
  extended: true
}))

// 解析json请求体的中间件
app.use(express.json())

// 这里用path是因为不同命令行工具可能路径格式不一样
app.use(express.static(path.join(__dirname, './static')))

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
  res.redirect('/vote/' + vote.id)
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

app.post('/voteup', async (req, res, next) => {

  // 接收到投票数据，判断该用户是否已在该问题下投过票
  // 如果投过了，就update数据，没投过就插入数据
  var userid = req.signedCookies.userid
  var body = req.body

  var voteupInfo = await db.get('SELECT * FROM voteups WHERE userid=? AND voteid=?', userid, body.voteid)

  if (voteupInfo) {
    await db.run('UPDATE voteups SET optionid=? WHERE userid=?', body.optionid, userid)
  } else {
    await db.run(
      'INSERT INTO voteups (userid, optionid, voteid) VALUES (?, ?, ?)',
      userid, req.body.optionid, body.voteid
    )
  }
  var voteups = await db.all('SELECT * FROM voteups WHERE voteid=?', req.body.voteid)
  res.json(voteups)
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

app.post('/login', async (req, res, next) => {
  var tryLogUser = req.body
  // 由于HTTP是无状态相应，创建cookie目的是便于再次登陆时直接登陆
  // 为登陆的用户创建cookie
  var loginSec = await db.get(
    'SELECT * FROM users WHERE name = "' + tryLogUser.name + '" AND password = "' + tryLogUser.password + '" '
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
  .post(async (req, res, next) => {
    var regInfo = req.body
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
        'INSERT INTO users (name, email, password) VALUES (?,?,?)',
        regInfo.name, regInfo.email, regInfo.password
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
    await db.run('UPDATE users SET password=? WHERE email=?', req.body.password, changePasswordTokenMap[token])
    // 重置密码后，令牌失效
    delete changePasswordTokenMap[token]
    res.end('密码重置成功')
  })

dbPromise.then(dbObject => {
  db = dbObject
  app.listen(port, () => {
    console.log('listening in port', port)
  })
})