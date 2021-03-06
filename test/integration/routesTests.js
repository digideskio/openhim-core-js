/* eslint-env mocha */

import request from 'supertest'
import nconf from 'nconf'
import { ChannelModelAPI } from '../../src/model/channels'
import { ClientModelAPI } from '../../src/model/clients'
import { TransactionModelAPI } from '../../src/model/transactions'
import * as testUtils from '../utils'
import { config } from '../../src/config'
import { ObjectId } from 'mongodb'
import { promisify } from 'util'
import * as constants from '../constants'
import sinon from 'sinon'

const { SERVER_PORTS } = constants
nconf.set('router', { httpPort: SERVER_PORTS.httpPort })

const server = require('../../src/server')

describe('Routes enabled/disabled tests', () => {
  let mockServer1 = null
  let mockServer2 = null
  let restrictedServer = null

  const httpPortPlus40 = constants.PORT_START + 40
  const httpPortPlus41 = constants.PORT_START + 41
  const httpPortPlus42 = constants.PORT_START + 42

  const sandbox = sinon.createSandbox()
  const restrictedSpy = sandbox.spy(async (req) => 'Restricted response')

  const channel1 = new ChannelModelAPI({
    name: 'TEST DATA - Mock endpoint 1',
    urlPattern: '^/test/channel1$',
    allow: ['PoC'],
    routes: [
      {
        name: 'test route',
        host: 'localhost',
        port: httpPortPlus40,
        primary: true
      }, {
        name: 'test route 2',
        host: 'localhost',
        port: httpPortPlus41
      }
    ],
    updatedBy: {
      id: new ObjectId(),
      name: 'Test'
    }
  })

  const channel2 = new ChannelModelAPI({
    name: 'TEST DATA - Mock endpoint 2',
    urlPattern: '^/test/channel2$',
    allow: ['PoC'],
    routes: [
      {
        name: 'test route',
        host: 'localhost',
        port: httpPortPlus40,
        status: 'disabled'
      }, {
        name: 'test route 2',
        host: 'localhost',
        port: httpPortPlus41,
        primary: true,
        status: 'enabled'
      }
    ],
    updatedBy: {
      id: new ObjectId(),
      name: 'Test'
    }
  })

  const channel3 = new ChannelModelAPI({
    name: 'TEST DATA - Mock endpoint 3',
    urlPattern: '^/test/channel3$',
    allow: ['PoC'],
    routes: [
      {
        name: 'test route',
        host: 'localhost',
        port: httpPortPlus40,
        primary: true,
        status: 'enabled'
      }, {
        name: 'test route 2',
        host: 'localhost',
        port: httpPortPlus41,
        primary: true,
        status: 'disabled'
      }
    ],
    updatedBy: {
      id: new ObjectId(),
      name: 'Test'
    }
  })

  const channelRestricted = new ChannelModelAPI({
    name: 'Restricted channel',
    urlPattern: '^/test/restricted$',
    allow: ['PoC'],
    methods: ['GET'],
    routes: [
      {
        name: 'restricted route',
        host: 'localhost',
        port: httpPortPlus42,
        primary: true,
        status: 'enabled'
      }
    ],
    updatedBy: {
      id: new ObjectId(),
      name: 'Test'
    }
  })

  before(async () => {
    config.authentication.enableMutualTLSAuthentication = false
    config.authentication.enableBasicAuthentication = true

    await Promise.all([
      channel1.save(),
      channel2.save(),
      channel3.save(),
      channelRestricted.save()
    ])

    const testAppDoc = {
      clientID: 'testApp',
      clientDomain: 'test-client.jembi.org',
      name: 'TEST Client',
      roles: [
        'OpenMRS_PoC',
        'PoC'
      ],
      passwordAlgorithm: 'sha512',
      passwordHash: '28dce3506eca8bb3d9d5a9390135236e8746f15ca2d8c86b8d8e653da954e9e3632bf9d85484ee6e9b28a3ada30eec89add42012b185bd9a4a36a07ce08ce2ea',
      passwordSalt: '1234567890',
      cert: ''
    }

    await new ClientModelAPI(testAppDoc).save()

    // Create mock endpoint to forward requests to
    mockServer1 = await testUtils.createMockHttpServer('target1', httpPortPlus40, 200)
    mockServer2 = await testUtils.createMockHttpServer('target2', httpPortPlus41, 200)
    restrictedServer = await testUtils.createMockHttpServer(restrictedSpy, httpPortPlus42, 200)

    await promisify(server.start)({ httpPort: SERVER_PORTS.httpPort })
  })

  after(async () => {
    await Promise.all([
      ChannelModelAPI.remove(),
      ClientModelAPI.remove(),
      mockServer1.close(),
      mockServer2.close(),
      restrictedServer.close(),
      promisify(server.stop)()
    ])
  })

  afterEach(async () => {
    sandbox.reset()
    await Promise.all([
      TransactionModelAPI.remove()
    ])
  })

  beforeEach(async () => { await TransactionModelAPI.remove() })

  it('should route transactions to routes that have no status specified (default: enabled)', async () => {
    const res = await request(constants.HTTP_BASE_URL)
      .get('/test/channel1')
      .auth('testApp', 'password')
      .expect(200)
    res.text.should.be.exactly('target1')
    // routes are async
    const trx = await TransactionModelAPI.findOne()
    trx.routes.length.should.be.exactly(1)
    trx.routes[0].should.have.property('name', 'test route 2')
    trx.routes[0].response.body.should.be.exactly('target2')
  })

  it('should NOT route transactions to disabled routes', async () => {
    const res = await request(constants.HTTP_BASE_URL)
      .get('/test/channel2')
      .auth('testApp', 'password')
      .expect(200)
    res.text.should.be.exactly('target2')
    // routes are async
    const trx = await TransactionModelAPI.findOne()
    trx.routes.length.should.be.exactly(0)
  })

  it('should ignore disabled primary routes (multiple primary routes)', async () => {
    const res = await request(constants.HTTP_BASE_URL)
      .get('/test/channel3')
      .auth('testApp', 'password')
      .expect(200)
    res.text.should.be.exactly('target1')
    // routes are async
    const trx = await TransactionModelAPI.findOne()
    trx.routes.length.should.be.exactly(0)
  })

  it('should allow a request if the method is in the "methods"', async () => {
    const res = await request(constants.HTTP_BASE_URL)
      .get('/test/restricted')
      .auth('testApp', 'password')
      .expect(200)
    res.text.should.be.exactly('Restricted response')
    // routes are async
    restrictedSpy.callCount.should.eql(1)
    const [req] = restrictedSpy.firstCall.args
    req.method.should.eql('GET')
  })

  it('should deny a request if the method is not in the "methods"', async () => {
    const res = await request(constants.HTTP_BASE_URL)
      .post('/test/restricted')
      .auth('testApp', 'password')
      .expect(405)

    res.body.toString().should.eql('Request with method POST is not allowed. Only GET methods are allowed')
    // routes are async
    restrictedSpy.callCount.should.eql(0)
  })
})
