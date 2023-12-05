const express = require('express');
const cors = require('cors');
var jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const formData = require('form-data');
const Mailgun = require('mailgun.js');
const mailgun = new Mailgun(formData);
const mg = mailgun.client({
	username: 'api',
	key: process.env.MAIL_GUN_API_KEY,
});
const app = express()
const port = process.env.PORT || 5000;

// middlewares
app.use(cors())
app.use(express.json())



const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zku3u3r.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db('bistroBossDB');
    const userCollection = database.collection('users');
    const menuCollection = database.collection('menu');
    const reviewCollection = database.collection('reviews');
    const cartCollection = database.collection('carts');
    const paymentCollection = database.collection('payments');

    //! generate jwt token
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {expiresIn: '1h'})
      res.send({token})
    })

    // verify token middle ware
    const verifyToken = (req, res, next) =>{
      // send error if token doesn't exist
      if(!req.headers.authorization){
        return res.status(401).send({message: 'fobidden access'})
      }
      // verify token if exist
      const token = req.headers.authorization.split(' ')[1]
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) =>{
        if(err){
          return res.status(401).send({message: 'fobidden access'})
        }
        req.decoded = decoded;
        next()
      })
    }


    // verify admin middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = {email: email}
      const user = await userCollection.findOne(query)
      const isAdmin = user?.role === 'admin';
      if(!isAdmin){
        return res.status(403).send({message: 'forbidden access'})
      }
      next()
    }


    // check if the user an admin or not
    app.get('/users/admin/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if(email !== req.decoded.email) {
        return res.status(403).send({message: 'unauthorized access'})
      }
      const query = {email: email}
      const user = await userCollection.findOne(query)
      let admin = false;
      if(user){
        admin = user?.role === 'admin'
      }
      res.send({admin})
    }) 

    
    //! users related api
    // get all users
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray()
      res.send(result)
    })

    // insert email if user doesn't exist
    app.post('/users', async (req, res) => {
      const user = req.body;
      const query = {email: user.email}
      const userExist = await userCollection.findOne(query)
      if(userExist){
        return res.send({message: 'Email already exist', insertedId: null})
      }
      const result = await userCollection.insertOne(user)
      res.send(result)
    })

    // make admin
    app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = {_id: new ObjectId(id)}
      const updatedDoc = {
        $set: {
          role: 'admin'
        }
      }
      const result = await userCollection.updateOne(filter, updatedDoc)
      res.send(result)
    })

    // delete user
    app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const result = await userCollection.deleteOne(query)
      res.send(result)
    })

    // get all menu
    app.get('/menu', async (req, res) => {
        const result = await menuCollection.find().toArray()
        res.send(result)
    })

    
    // insert item into menu
    app.post('/menu', verifyToken, verifyAdmin, async (req, res) => {
      const item = req.body;
      const result = await menuCollection.insertOne(item)
      res.send(result)
    })

    
    // get all reviews
    app.get('/reviews', async (req, res) => {
        const result = await reviewCollection.find().toArray()
        res.send(result)
    })


    // cart collections
    app.get('/carts', async (req, res) => {
      const email = req.query.email;
      const query = {email: email}
      const result = await cartCollection.find(query).toArray()
      res.send(result)
    })
    
    app.post('/carts', async (req, res) => {
      const cartItem = req.body;
      const result = await cartCollection.insertOne(cartItem)
      res.send(result)
    })

    app.delete('/carts/:id', async (req, res) => {
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const result = await cartCollection.deleteOne(query)
      res.send(result)
    })


    // payment intent api
    app.post('/create-payment-intent', async (req, res) => {
      const {price} = req.body;
      const amount = parseInt(price * 100)

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        payment_method_types: ['card']
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      })
    })


    // get all payments of specific user
    app.get('/payments/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = {email: email}
      const result = await paymentCollection.find(query).toArray()
      res.send(result)
    })

    // save payments on database
    app.post('/payments', async (req, res) => {
      const payment = req.body;
      const result = await paymentCollection.insertOne(payment)

      // carefully delete each item from cart
      const query = {_id: {
        $in: payment.cartIds.map(id => new ObjectId(id))
      }}

      // clear cart after payment
      const deleteResult = await cartCollection.deleteMany(query)

      // send email after payment
      mg.messages
      .create(process.env.MAIL_SENDING_DOMAIN, {
        from: "Mailgun Sandbox <postmaster@sandboxc2fddb9056fd4e96baaf433c0ee97a3b.mailgun.org>",
        to: ["myemail.abc20@gmail.com"],
        subject: "Bistro Boss Confirmation",
        text: "Testing some Mailgun awesomness!",
        html: `
        <div>
          <h2>Thank you for your order</h2>
          <h4>Your Trans. Id: <strong>${payment.transactionId}</strong></h4>
          <p>We would like to get you feedback about food</p>
        </div>
        `
      })
      .then(msg => console.log(msg)) // logs response data
      .catch(err => console.log(err)); // logs any error`;

      res.send({result, deleteResult})
    })
    

    
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Boss Server is running')
})

app.listen(port, () => {
    console.log(`Restaurant server is running on port ${port}`)
})


/**
 * ----------NAMING CONVENTION-----------
 * app.get('/users')
 * app.get('/users/:id')
 * app.post('/users')
 * app.patch('/users/:id')
 * app.put('/users/:id')
 * app.delete('/users/:id')
 */