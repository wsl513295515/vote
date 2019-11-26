const express = require('express')
const cookieParser = require('cookie-parser')

const port = 3008

// 创建一个静态库，现实中应该是一个数据库
const users = [{
  name: 'a',
  email: 'a@qq.com',
  password: 'a'
}, {
  name: 'b',
  email: 'b@qq.com',
  password: 'b'
}]

// 更改密码时，令牌和更改密码的用户之间的映射
const changePasswordTokenMap = {}

const app = express()

// 创建cookie
app.use(cookieParser('my secret'))

// 解析post请求的请求体
app.use(express.urlencoded({
  extended: true
}))

app.use(express.static(__dirname + './static'))

// 简陋的设置一下响应头的文本格式
app.use((req, res, next) => {
  res.set("Content-type", "text/html; charset=UTF-8")
  next()
})


app.get('/create', (req, res, next) => {
  res.end('创建投票')
})

app.get('/vote/:id', (req, res, next) => {

})

// 首页如果有cookie的用户直接进入，
// 如果没有则需要先登录或注册
app.get('/', (req, res, next) => {
    if (req.signedCookies.user) {
      res.end(`
        <div>
          <h1>Hello ${req.signedCookies.user}</h1>
          <a href="/create">创建投票</a>
          <a href="/logout">退出登陆</a>
        </div>
      `)
    } else {
      res.end(`
        <form method="post" action="/login">
          用户名：<input type="text" name="name" /></br>
          密码：<input type="password" name="password" /></br>
          <button>登陆</button>
        </form>
        <form method="get" action="/register">
          <button>注册</button>
        </form>
        <a href="/forget">忘记密码</a>
      `)
    }
  })

app.post('/login', (req, res, next) => {
  var tryLogUser = req.body
  // 由于HTTP是无状态相应，创建cookie目的是便于再次登陆时直接登陆
  // 为登陆的用户创建cookie
  if (users.find(it => it.name === tryLogUser.name && it.password === tryLogUser.password)) {
    res.cookie('user', tryLogUser.name, {
      signed: true
    })
    res.redirect('/')
  } else {
    res.end(`
      <div>
        <span>用户名或密码错误</sapn>
        <span><span id="countDown">3</span>秒钟后回跳转至首页，如果没有跳转请<a href="/">点击跳转</a></span>
      </div>
      <script>
        setTimeout(() => {
          location.href = './'
        },3000)
        var cd = 3
        setInterval(() => {
          countDown.textContent = --cd
        },1000)
      </script>
    `)
  }
})

app.get('/logout', (req, res, next) => {
  // 退出登陆，清除cookie
  res.clearCookie('user')
  res.redirect('/')
})

app.route('/register')
  .get((req, res, next) => {
    res.end(`
      <form method="post" action="/register">
        用户名：<input type="text" name="name" /></br>
        邮箱：<input type="email" name="email" /><br>
        密码：<input type="password" name="password" /></br>
        <button>注册</button>
      </form>
    `)
  })
  .post((req, res, next) => {
    var tryUserInfo = req.body
    if (users.find(it => it.name === tryUserInfo.name)) {
      res.end('用户名已被注册')
    } if (users.find(it => it.email === tryUserInfo.email)) {
      res.end('邮箱已被注册')
    } else {
      users.push(tryUserInfo)
      res.end('注册成功')
      console.log(users)
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
  .post((req, res, next) => {

    // 忘记密码的邮箱先与令牌（token）建立映射关系
    // token 是一个随机数，20分钟无操作需清除
    var email = req.body.email
    var token = Math.random().toString().slice(2)
    changePasswordTokenMap[token] = email

    setTimeout(() => {
      delete changePasswordTokenMap[token]
    },60 * 1000 * 20)

    if (users.find(it => it.email === email)) {
      var link = `http://localhost:3008/changePassword/${token}`
      
      // 这里实际上是要向目标邮箱发送一个邮件的
      // 暂时用log代替
      console.log(link)

      res.end('已向您的邮箱发送重置链接')
    } else {
      res.end('请输入正确邮箱')
    }
  })

app.route('/changePassword/:token')
  .get((req, res, next) => {
    var token = req.params.token
    var user = users.find(it => it.email === changePasswordTokenMap[token])
    res.end(`
      <form method="post" action="">
        <h3>正在重置${user.name}用户密码</h3><br>
        <input type="password" name="password" />
        <button>确定</button>
      </form>
    `)
  })
  .post((req, res, next) => {
    var token = req.params.token
    var user = users.find(it => it.email === changePasswordTokenMap[token])
    if (user) {
      user.password = req.body.password
      // 重置密码后，令牌失效
      delete changePasswordTokenMap[token]
      res.end('密码重置成功')
    } else {
      // 造成user不存在的原因可能是操作时间过长，链接失效
      res.end('此链接已失效')
    }
  })

app.listen(port, () => {
  console.log('listening in port', port)
})